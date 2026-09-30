import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteStatement, SqliteValue } from "./database.ts";
import { SqliteStorage } from "./storage.ts";

/** Node SQLite connection settings for a durable storage file. */
export type NodeSqliteStorageOptions = {
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

type RunOperation = <T>(operation: () => T | Promise<T>) => Promise<T>;
type TransactionScope = { active: boolean };

class SerialOperationQueue {
	private tail = Promise.resolve();

	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release!();
		}
	}
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: StatementSync;
	private readonly runOperation: RunOperation;

	constructor(statement: StatementSync, runOperation: RunOperation) {
		this.statement = statement;
		this.runOperation = runOperation;
	}

	run(...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement.run(...(params as SQLInputValue[]));
		});
	}

	get<T extends object>(...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement.get(...(params as SQLInputValue[])) as T | undefined);
	}

	all<T extends object>(...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement.all(...(params as SQLInputValue[])) as T[]);
	}
}

class NodeSqliteTransaction implements SqliteExecutor {
	private readonly database: DatabaseSync;
	private readonly scope: TransactionScope;

	constructor(database: DatabaseSync, scope: TransactionScope) {
		this.database = database;
		this.scope = scope;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	prepare(sql: string): Promise<SqliteStatement> {
		return this.runOperation(
			() => new NodeSqliteStatement(this.database.prepare(sql), (operation) => this.runOperation(operation)),
		);
	}

	private async runOperation<T>(operation: () => T | Promise<T>): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase implements SqliteDatabase {
	private readonly database: DatabaseSync;
	private readonly access = new SerialOperationQueue();
	/** Detects database calls from inside a transaction callback, which would otherwise wait for that transaction forever. */
	private readonly transactionScope = new AsyncLocalStorage<TransactionScope>();
	private closed = false;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	prepare(sql: string): Promise<SqliteStatement> {
		return this.runOperation(
			() => new NodeSqliteStatement(this.database.prepare(sql), (operation) => this.runOperation(operation)),
		);
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.insideTransaction()) {
			return Promise.reject(new Error("Nested SQLite transactions are not supported"));
		}
		return this.access.run(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await this.transactionScope.run(scope, () =>
					callback(new NodeSqliteTransaction(this.database, scope)),
				);
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		if (this.insideTransaction()) {
			return Promise.reject(new Error("Cannot close SQLite during an active transaction"));
		}
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}

	private runOperation<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.insideTransaction()) {
			return Promise.reject(new Error("Use the transaction handle inside a transaction callback"));
		}
		return this.access.run(operation);
	}

	private insideTransaction(): boolean {
		return this.transactionScope.getStore()?.active === true;
	}
}

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout });
	const adapter = new NodeSqliteDatabase(database);
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}

/** Open or create file-backed durable storage using Node's built-in SQLite. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(await openNodeSqliteDatabase(path, options));
}
