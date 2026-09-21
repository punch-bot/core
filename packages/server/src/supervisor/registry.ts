import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SandboxRecord {
	readonly id: string;
	readonly workspaceId: string;
	readonly generation: string;
	readonly token: string;
	readonly container: string;
	readonly volume: string;
	readonly desired: "running" | "stopped" | "deleted";
	readonly state: "starting" | "ready" | "stopping" | "stopped" | "failed" | "deleted";
	readonly deleteData: boolean;
}

/** Host-side metadata only. Session contents and working files belong to sandbox volumes. */
export class SandboxRegistry {
	readonly #db: DatabaseSync;
	readonly #ownership: DatabaseSync;
	readonly owner: string;
	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// A separate SQLite transaction supplies an OS-released process lock without
		// holding the metadata database's writes uncommitted for the process lifetime.
		const ownershipPath = path === ":memory:" ? path : `${path}.owner`;
		this.#ownership = new DatabaseSync(ownershipPath, { timeout: 0 });
		try {
			if (path !== ":memory:") chmodSync(ownershipPath, 0o600);
			this.#ownership.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			this.#ownership.close();
			throw new Error("Supervisor registry is already owned or unavailable", { cause: error });
		}
		try {
			this.#db = new DatabaseSync(path, { timeout: 5_000 });
		} catch (error) {
			this.#ownership.close();
			throw error;
		}
		try {
			if (path !== ":memory:") chmodSync(path, 0o600);
			this.#db.exec(`
				PRAGMA journal_mode=WAL;
				CREATE TABLE IF NOT EXISTS supervisor_identity (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS supervisor_sandboxes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, record TEXT NOT NULL);
			`);
			this.#db.prepare("INSERT OR IGNORE INTO supervisor_identity VALUES (1, ?)").run(randomUUID());
			this.owner = String(this.#db.prepare("SELECT owner FROM supervisor_identity WHERE id=1").get()!.owner);
		} catch (error) {
			this.#db.close();
			this.#ownership.close();
			throw error;
		}
	}
	create(workspaceId: string): SandboxRecord {
		if (!workspaceId.trim() || workspaceId.length > 256) throw new Error("Invalid workspace ID");
		const id = randomUUID();
		const record: SandboxRecord = {
			id,
			workspaceId,
			generation: randomUUID(),
			token: randomBytes(32).toString("base64url"),
			container: `punch-${id}`,
			volume: `punch-data-${id}`,
			desired: "stopped",
			state: "stopped",
			deleteData: false,
		};
		this.#db
			.prepare("INSERT INTO supervisor_sandboxes VALUES (?, ?, ?)")
			.run(id, workspaceId, JSON.stringify(record));
		return record;
	}
	get(id: string, workspaceId: string): SandboxRecord {
		const row = this.#db
			.prepare("SELECT record FROM supervisor_sandboxes WHERE id=? AND workspace_id=?")
			.get(id, workspaceId);
		if (!row) throw new Error("Sandbox not found");
		return JSON.parse(String(row.record)) as SandboxRecord;
	}
	list(): SandboxRecord[] {
		return this.#db
			.prepare("SELECT record FROM supervisor_sandboxes")
			.all()
			.map((row) => JSON.parse(String(row.record)) as SandboxRecord);
	}
	/** Compare-and-swap prevents a stale lifecycle task from overwriting a newer generation. */
	save(record: SandboxRecord, previous: SandboxRecord): void {
		if (
			record.id !== previous.id ||
			record.workspaceId !== previous.workspaceId ||
			record.volume !== previous.volume ||
			record.container !== previous.container
		)
			throw new Error("Sandbox identity is immutable");
		const result = this.#db
			.prepare("UPDATE supervisor_sandboxes SET record=? WHERE id=? AND workspace_id=? AND record=?")
			.run(JSON.stringify(record), previous.id, previous.workspaceId, JSON.stringify(previous));
		if (result.changes !== 1) throw new Error("Sandbox changed during lifecycle operation");
	}
	close(): void {
		try {
			this.#db.close();
		} finally {
			this.#ownership.close();
		}
	}
}
