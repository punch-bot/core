/** Values supported by the portable SQLite storage core. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/** A prepared SQLite statement that supports repeated execution with new bindings. */
export interface SqliteStatement {
	run(...params: SqliteValue[]): Promise<void>;
	get<T extends object>(...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(...params: SqliteValue[]): Promise<T[]>;
}

/** Asynchronous SQL operations shared by a database and its transaction handles. */
export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	prepare(sql: string): Promise<SqliteStatement>;
}

/**
 * Minimal database facade required by `SqliteStorage`.
 *
 * All operations are asynchronous so adapters may execute outside the harness runtime.
 *
 * `transaction` passes the callback a transaction handle. All work in the transaction
 * must use that handle; the handle and statements prepared through it are invalid after
 * the callback settles. Adapters must queue unrelated operations and other transactions
 * until the transaction finishes. The returned promise settles after commit or rollback.
 *
 * When the callback rejects, the adapter must roll the transaction back before rejecting
 * with that same error. If rollback fails, it must reject with a different error (for
 * example an `AggregateError`) so callers cannot mistake the callback error for a
 * guaranteed rollback.
 */
export interface SqliteDatabase extends SqliteExecutor {
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
