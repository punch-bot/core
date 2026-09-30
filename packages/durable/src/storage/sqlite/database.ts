/** Values supported by the portable SQLite storage core. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/** A prepared SQLite statement that supports repeated execution with new bindings across transactions. */
export interface SqliteStatement {
	run(...params: SqliteValue[]): Promise<void>;
	get<T extends object>(...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(...params: SqliteValue[]): Promise<T[]>;
}

/**
 * Minimal database facade required by `SqliteStorage`.
 *
 * All operations are asynchronous so adapters may execute outside the harness runtime.
 * Operations started by a transaction callback belong to that transaction; adapters
 * must queue unrelated operations until the callback settles. When a callback rejects,
 * the adapter must roll the transaction back before rejecting with that same error. If
 * rollback fails, it must reject with a different error (for example an `AggregateError`)
 * so callers cannot mistake the callback error for a guaranteed rollback.
 */
export interface SqliteDatabase {
	exec(sql: string): Promise<void>;
	prepare(sql: string): Promise<SqliteStatement>;
	transaction<T>(callback: () => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
