import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAgentDir } from "../../config.ts";
import {
	applyTodoAction,
	loadTodos,
	type TodoAction,
	type TodoActionResult,
	type TodoState,
	todosFile,
} from "./todos.ts";

export function todoDatabasePath(): string {
	return join(process.env.PI_DATA_DIR || getAgentDir(), "todos.sqlite");
}

/** One database per sandbox. Every mutation reads and writes under the same SQLite write transaction. */
export class TodoStore {
	readonly #db: DatabaseSync;
	readonly #legacyFile: string;

	constructor(path = todoDatabasePath(), legacyFile = todosFile()) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new DatabaseSync(path, { timeout: 5_000 });
		if (path !== ":memory:") chmodSync(path, 0o600);
		this.#legacyFile = legacyFile;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS todo_states (
				session_id TEXT PRIMARY KEY,
				next_id INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS todo_items (
				session_id TEXT NOT NULL REFERENCES todo_states(session_id) ON DELETE CASCADE,
				id INTEGER NOT NULL,
				position INTEGER NOT NULL,
				text TEXT NOT NULL,
				done INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, id),
				UNIQUE (session_id, position)
			);
			CREATE TABLE IF NOT EXISTS todo_logs (
				session_id TEXT NOT NULL REFERENCES todo_states(session_id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				at INTEGER NOT NULL,
				summary TEXT NOT NULL,
				PRIMARY KEY (session_id, position)
			);
			CREATE TABLE IF NOT EXISTS todo_deleted (session_id TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS todo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}

	load(sessionId: string): TodoState {
		this.#db.exec("BEGIN");
		try {
			const state = this.#read(sessionId);
			this.#db.exec("COMMIT");
			return state;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#read(sessionId: string): TodoState {
		if (!sessionId) throw new Error("Session ID is required");
		if (this.#db.prepare("SELECT 1 FROM todo_deleted WHERE session_id = ?").get(sessionId)) {
			return { todos: [], nextId: 1, log: [] };
		}
		const row = this.#db.prepare("SELECT next_id FROM todo_states WHERE session_id = ?").get(sessionId) as
			| { next_id: number }
			| undefined;
		if (!row) return { todos: [], nextId: 1, log: [] };
		const items = this.#db
			.prepare("SELECT id, text, done, created_at FROM todo_items WHERE session_id = ? ORDER BY position")
			.all(sessionId) as Array<{ id: number; text: string; done: number; created_at: number }>;
		const logs = this.#db
			.prepare("SELECT at, summary FROM todo_logs WHERE session_id = ? ORDER BY position")
			.all(sessionId) as Array<{ at: number; summary: string }>;
		return {
			todos: items.map((item) => ({
				id: item.id,
				text: item.text,
				done: item.done !== 0,
				createdAt: item.created_at,
			})),
			nextId: row.next_id,
			log: logs,
		};
	}

	apply(sessionId: string, action: TodoAction): TodoActionResult {
		if (action.action === "list") return applyTodoAction(this.load(sessionId), action);
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			if (this.#db.prepare("SELECT 1 FROM todo_deleted WHERE session_id = ?").get(sessionId)) {
				throw new Error("Session tasks were deleted");
			}
			const result = applyTodoAction(this.#read(sessionId), action);
			if (result.changed) this.#write(sessionId, result.state);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Import the former sandbox-wide list once, into the first session that opens it. Keep the source file. */
	migrateLegacy(sessionId: string): void {
		if (!sessionId) throw new Error("Session ID is required");
		if (!existsSync(this.#legacyFile)) return;
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const migrated = this.#db.prepare("SELECT value FROM todo_meta WHERE key = 'legacy_migrated'").get();
			if (!migrated) {
				if (
					!this.#db.prepare("SELECT 1 FROM todo_deleted WHERE session_id = ?").get(sessionId) &&
					!this.#db.prepare("SELECT 1 FROM todo_states WHERE session_id = ?").get(sessionId)
				) {
					const parsed = JSON.parse(readFileSync(this.#legacyFile, "utf8")) as unknown;
					if (
						typeof parsed !== "object" ||
						parsed === null ||
						!Array.isArray((parsed as Partial<TodoState>).todos) ||
						!Array.isArray((parsed as Partial<TodoState>).log)
					) {
						throw new Error("Invalid legacy todo file");
					}
					const state = loadTodos(this.#legacyFile);
					if (state.todos.length > 0 || state.log.length > 0) this.#write(sessionId, state);
				}
				this.#db.prepare("INSERT INTO todo_meta (key, value) VALUES ('legacy_migrated', ?)").run(sessionId);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	delete(sessionId: string): void {
		if (!sessionId) throw new Error("Session ID is required");
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			this.#db.prepare("INSERT OR IGNORE INTO todo_deleted (session_id) VALUES (?)").run(sessionId);
			this.#db.prepare("DELETE FROM todo_states WHERE session_id = ?").run(sessionId);
			if (existsSync(this.#legacyFile)) {
				this.#db
					.prepare("INSERT OR IGNORE INTO todo_meta (key, value) VALUES ('legacy_migrated', ?)")
					.run(sessionId);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#db.close();
	}

	#write(sessionId: string, state: TodoState): void {
		this.#db
			.prepare(
				"INSERT INTO todo_states (session_id, next_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET next_id = excluded.next_id",
			)
			.run(sessionId, state.nextId);
		this.#db.prepare("DELETE FROM todo_items WHERE session_id = ?").run(sessionId);
		this.#db.prepare("DELETE FROM todo_logs WHERE session_id = ?").run(sessionId);
		const itemInsert = this.#db.prepare(
			"INSERT INTO todo_items (session_id, id, position, text, done, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const [position, item] of state.todos.entries()) {
			itemInsert.run(sessionId, item.id, position, item.text, item.done ? 1 : 0, item.createdAt);
		}
		const logInsert = this.#db.prepare(
			"INSERT INTO todo_logs (session_id, position, at, summary) VALUES (?, ?, ?, ?)",
		);
		for (const [position, entry] of state.log.entries()) {
			logInsert.run(sessionId, position, entry.at, entry.summary);
		}
	}
}

let sharedStore: TodoStore | undefined;

export function getTodoStore(): TodoStore {
	sharedStore ??= new TodoStore();
	return sharedStore;
}
