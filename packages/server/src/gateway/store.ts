import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, JsonValue } from "@punch-bot/chord";
import { RemoteServiceError } from "@punch-bot/chord";
import { getPrincipal, type Principal } from "../principal.ts";

export interface ConversationKey {
	readonly platform: string;
	readonly installationId: string;
	readonly conversationId: string;
}

export type EventReceipt = { status: "pending" | "completed" | "failed"; result: JsonValue | null };

/** Completed receipts and rendered message IDs are pruned after this age; pending claims never expire. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One gateway database per logical Punch server. SQLite arbitrates competing event claims. */
export class GatewayStore {
	readonly #db: DatabaseSync;
	readonly #allowLocal: boolean;
	constructor(path: string, options: { allowLocal?: boolean } = {}) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new DatabaseSync(path, { timeout: 5_000 });
		if (path !== ":memory:") chmodSync(path, 0o600);
		this.#allowLocal = options.allowLocal ?? false;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS gateway_sessions (
				session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, creator_id TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS gateway_conversations (
				key TEXT PRIMARY KEY, session_id TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS gateway_events (
				key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS gateway_messages (
				key TEXT PRIMARY KEY, message_id TEXT NOT NULL, created_at INTEGER NOT NULL
			);
		`);
	}
	async canAccess(permission: string, sessionId: string | undefined, context: Context): Promise<boolean> {
		const principal = getPrincipal(context);
		if (!principal) return this.#allowLocal;
		if (!principal.permissions.includes(permission)) return false;
		if (sessionId === undefined) return true;
		const row = this.#db.prepare("SELECT workspace_id FROM gateway_sessions WHERE session_id = ?").get(sessionId);
		return row?.workspace_id === principal.workspaceId;
	}
	async authorize(permission: string, sessionId: string | undefined, context: Context): Promise<void> {
		if (!(await this.canAccess(permission, sessionId, context))) {
			throw new RemoteServiceError("service_not_allowed", "Session access denied");
		}
	}
	async created(sessionId: string, context: Context): Promise<void> {
		const principal = getPrincipal(context);
		if (!principal) {
			if (this.#allowLocal) return;
			throw new RemoteServiceError("service_not_allowed", "Authentication required");
		}
		this.grantSession(sessionId, principal);
	}
	/** Administrative import of an existing session. Ownership cannot be overwritten. */
	grantSession(sessionId: string, principal: Principal): void {
		this.#db
			.prepare("INSERT INTO gateway_sessions VALUES (?, ?, ?)")
			.run(sessionId, principal.workspaceId, principal.userId);
	}
	conversation(principal: Principal, key: ConversationKey): string | undefined {
		const row = this.#db
			.prepare("SELECT session_id FROM gateway_conversations WHERE key = ?")
			.get(conversationKey(principal, key));
		return typeof row?.session_id === "string" ? row.session_id : undefined;
	}
	bind(principal: Principal, key: ConversationKey, sessionId: string): void {
		this.#db
			.prepare(
				"INSERT INTO gateway_conversations VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET session_id = excluded.session_id",
			)
			.run(conversationKey(principal, key), sessionId);
	}
	/** Drop ownership and conversation bindings for a session that no longer exists. */
	async removed(sessionId: string, _context: Context): Promise<void> {
		this.#db.prepare("DELETE FROM gateway_conversations WHERE session_id = ?").run(sessionId);
		this.#db.prepare("DELETE FROM gateway_sessions WHERE session_id = ?").run(sessionId);
	}
	/** A pending claim survives crashes. Never retry an operation with an uncertain outcome. */
	claim(principal: Principal, key: ConversationKey, eventId: string): EventReceipt | undefined {
		this.#db
			.prepare("DELETE FROM gateway_events WHERE status != 'pending' AND created_at < ?")
			.run(Date.now() - RETENTION_MS);
		const id = JSON.stringify([conversationKey(principal, key), eventId]);
		const inserted = this.#db
			.prepare("INSERT OR IGNORE INTO gateway_events VALUES (?, 'pending', NULL, ?)")
			.run(id, Date.now());
		if (inserted.changes !== 0) return undefined;
		const row = this.#db.prepare("SELECT status, result FROM gateway_events WHERE key = ?").get(id)!;
		if (row.status !== "pending" && row.status !== "completed" && row.status !== "failed")
			throw new Error("Invalid gateway receipt");
		return {
			status: row.status,
			result: typeof row.result === "string" ? (JSON.parse(row.result) as JsonValue) : null,
		};
	}
	complete(
		principal: Principal,
		key: ConversationKey,
		eventId: string,
		status: "completed" | "failed",
		result: JsonValue,
	): void {
		const id = JSON.stringify([conversationKey(principal, key), eventId]);
		this.#db
			.prepare("UPDATE gateway_events SET status = ?, result = ? WHERE key = ?")
			.run(status, JSON.stringify(result), id);
	}
	/** Persist the runtime lookup key before submission, so an uncertain receipt can be inspected. */
	recordOperation(
		principal: Principal,
		key: ConversationKey,
		eventId: string,
		sessionId: string,
		operationId: string,
	): void {
		const id = JSON.stringify([conversationKey(principal, key), eventId]);
		this.#db
			.prepare("UPDATE gateway_events SET result=? WHERE key=? AND status='pending'")
			.run(JSON.stringify({ sessionId, operationId }), id);
	}
	message(principal: Principal, key: ConversationKey, outputId: string): string | undefined {
		const row = this.#db
			.prepare("SELECT message_id FROM gateway_messages WHERE key = ?")
			.get(JSON.stringify([conversationKey(principal, key), outputId]));
		return typeof row?.message_id === "string" ? row.message_id : undefined;
	}
	recordMessage(principal: Principal, key: ConversationKey, outputId: string, messageId: string): void {
		this.#db.prepare("DELETE FROM gateway_messages WHERE created_at < ?").run(Date.now() - RETENTION_MS);
		this.#db
			.prepare(
				"INSERT INTO gateway_messages VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET message_id = excluded.message_id, created_at = excluded.created_at",
			)
			.run(JSON.stringify([conversationKey(principal, key), outputId]), messageId, Date.now());
	}
	close(): void {
		this.#db.close();
	}
}

export function conversationKey(principal: Principal, key: ConversationKey): string {
	return JSON.stringify([principal.workspaceId, key.platform, key.installationId, key.conversationId]);
}
