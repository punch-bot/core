// Keep this interface limited to the API shared by node:sqlite and bun:sqlite.
// Driver changes must be checked with both Node and a compiled Bun smoke test.
interface Statement {
	run(...params: Array<string | number>): unknown;
	get(...params: Array<string | number>): Record<string, unknown> | undefined;
	all(...params: Array<string | number>): Array<Record<string, unknown>>;
}

export declare class DatabaseSync {
	constructor(path: string);
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}
