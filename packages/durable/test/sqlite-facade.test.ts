import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { describe, expect, it } from "vitest";
import { StorageRejected } from "../src/errors.ts";
import { idFromNumber } from "../src/ids.ts";
import type { SqliteDatabase, SqliteStatement } from "../src/storage/sqlite/index.ts";
import { SqliteStorage } from "../src/storage/sqlite/index.ts";
import { type NodeSqliteDatabase, openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

type SettlementMode = "immediate" | "delay" | "reject";

class ControlledSettlementDatabase implements SqliteDatabase {
	private readonly delegate: NodeSqliteDatabase;
	private mode: SettlementMode = "immediate";
	private pendingSettlement: (() => void) | undefined;
	private readonly prepareCounts = new Map<string, number>();

	constructor(delegate: NodeSqliteDatabase) {
		this.delegate = delegate;
	}

	exec(sql: string): Promise<void> {
		return this.delegate.exec(sql);
	}

	prepare(sql: string): Promise<SqliteStatement> {
		this.prepareCounts.set(sql, (this.prepareCounts.get(sql) ?? 0) + 1);
		return this.delegate.prepare(sql);
	}

	transaction<T>(callback: () => Promise<T>): Promise<T> {
		const mode = this.mode;
		this.mode = "immediate";
		if (mode === "immediate") return this.delegate.transaction(callback);
		const settlement = this.delegate.transaction(async () => {
			const value = await callback();
			if (mode === "reject") throw new Error("controlled settlement rejection");
			return value;
		});
		return new Promise<T>((resolve, reject) => {
			this.pendingSettlement = () => void settlement.then(resolve, reject);
		});
	}

	close(): Promise<void> {
		return this.delegate.close();
	}

	prepareCount(sql: string): number {
		return this.prepareCounts.get(sql) ?? 0;
	}

	controlNextSettlement(mode: Exclude<SettlementMode, "immediate">): void {
		if (this.pendingSettlement !== undefined) throw new Error("A settlement is already pending");
		this.mode = mode;
	}

	settle(): void {
		const settle = this.pendingSettlement;
		if (settle === undefined) throw new Error("No settlement is pending");
		this.pendingSettlement = undefined;
		settle();
	}
}

describe("portable SQLite facade settlement", () => {
	it("prepares each storage statement once and rebinds it across commits", async () => {
		const database = new ControlledSettlementDatabase(await openNodeSqliteDatabase(":memory:"));
		const storage = await SqliteStorage.open(database);
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
		await storage.commit(
			Array.from({ length: 100 }, (_, index) => ({
				type: "entry" as const,
				value: { id: idFromNumber<EntryId>(index + 2), conversationId: ROOT_CONVERSATION_ID, kind: "cached" },
			})),
			BACKGROUND_CONTEXT,
		);
		await storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(102), conversationId: ROOT_CONVERSATION_ID, kind: "cached-again" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		expect((await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached");
		expect((await storage.entry(idFromNumber<EntryId>(102), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached-again");
		await expect(
			storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT),
		).rejects.toThrow("ID 1 already belongs to conversation");
		expect((await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached");
		expect(database.prepareCount("SELECT record, commit_seq FROM entries WHERE id = ?")).toBe(1);
		expect(database.prepareCount("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, ?)")).toBe(1);
		expect(
			database.prepareCount(
				"INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)",
			),
		).toBe(1);
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("supports asynchronous Node transaction callbacks and closes idempotently", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.transaction(async () => {
			await database.exec("CREATE TABLE async_probe (value INTEGER)");
			await (await database.prepare("INSERT INTO async_probe (value) VALUES (?)")).run(1);
		});
		expect(await (await database.prepare("SELECT value FROM async_probe")).get()).toEqual({ value: 1 });
		await database.close();
		await database.close();
	});

	it("serializes concurrent transactions", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE transaction_queue (value INTEGER)");
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = database.transaction(async () => {
			await database.exec("INSERT INTO transaction_queue (value) VALUES (1)");
			markFirstStarted();
			await firstGate;
		});
		await firstStarted;

		let secondStarted = false;
		const second = database.transaction(async () => {
			secondStarted = true;
			await database.exec("INSERT INTO transaction_queue (value) VALUES (2)");
		});
		await Promise.resolve();
		expect(secondStarted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);
		expect(await (await database.prepare("SELECT value FROM transaction_queue ORDER BY value")).all()).toEqual([
			{ value: 1 },
			{ value: 2 },
		]);
		await database.close();
	});

	it("queues ordinary operations behind an active transaction", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE operation_queue (value INTEGER)");
		const readStatement = await database.prepare("SELECT value FROM operation_queue ORDER BY value");
		let markTransactionStarted!: () => void;
		const transactionStarted = new Promise<void>((resolve) => {
			markTransactionStarted = resolve;
		});
		let releaseTransaction!: () => void;
		const transactionGate = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		const transaction = database.transaction(async () => {
			await database.exec("INSERT INTO operation_queue (value) VALUES (1)");
			markTransactionStarted();
			await transactionGate;
		});
		await transactionStarted;

		let writeSettled = false;
		const write = database.exec("INSERT INTO operation_queue (value) VALUES (2)").finally(() => {
			writeSettled = true;
		});
		let readSettled = false;
		const read = readStatement.all().finally(() => {
			readSettled = true;
		});
		await Promise.resolve();
		expect(writeSettled).toBe(false);
		expect(readSettled).toBe(false);

		releaseTransaction();
		await transaction;
		await write;
		await expect(read).resolves.toEqual([{ value: 1 }, { value: 2 }]);
		await database.close();
	});

	it("does not share an in-flight prepare across transaction contexts after reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-sqlite-cache-"));
		const path = join(directory, "storage.sqlite");
		try {
			const initial = await openNodeSqliteStorage(path);
			await initial.close(BACKGROUND_CONTEXT);

			const database = await openNodeSqliteDatabase(path);
			const storage = await SqliteStorage.open(database);
			let markTransactionStarted!: () => void;
			const transactionStarted = new Promise<void>((resolve) => {
				markTransactionStarted = resolve;
			});
			let releaseTransaction!: () => void;
			const transactionGate = new Promise<void>((resolve) => {
				releaseTransaction = resolve;
			});
			const transaction = database.transaction(async () => {
				markTransactionStarted();
				await transactionGate;
				return storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
			});
			await transactionStarted;

			const concurrentRead = storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
			releaseTransaction();
			await expect(Promise.all([transaction, concurrentRead])).resolves.toEqual([undefined, undefined]);
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects close from an active transaction", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await expect(database.transaction(async () => database.close())).rejects.toThrow(
			"Cannot close SQLite during an active transaction",
		);
		await database.close();
	});

	it("does not preserve a guaranteed rejection when rollback itself fails", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE rollback_probe (value INTEGER)");
		await expect(
			database.transaction(async () => {
				await database.exec("INSERT INTO rollback_probe (value) VALUES (1)");
				await database.exec("COMMIT");
				throw new StorageRejected("rejected after an escaped commit");
			}),
		).rejects.toThrow(AggregateError);
		expect(await (await database.prepare("SELECT value FROM rollback_probe")).get()).toEqual({ value: 1 });
		await database.close();
	});

	it("awaits async transaction settlement and adopts IDs only after success", async () => {
		const database = new ControlledSettlementDatabase(await openNodeSqliteDatabase(":memory:"));
		database.controlNextSettlement("delay");
		const opening = SqliteStorage.open(database);
		let opened = false;
		void opening.then(() => {
			opened = true;
		});
		await Promise.resolve();
		expect(opened).toBe(false);
		database.settle();
		const storage = await opening;

		database.controlNextSettlement("delay");
		const committing = storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(100), conversationId: ROOT_CONVERSATION_ID, kind: "settled" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		let committed = false;
		void committing.then(() => {
			committed = true;
		});
		await Promise.resolve();
		expect(committed).toBe(false);
		expect(await storage.mintId<EntryId>()).toBe(2);
		database.settle();
		await expect(committing).resolves.toBe(1);
		expect(await storage.mintId<EntryId>()).toBe(101);

		database.controlNextSettlement("reject");
		const rejected = storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(200), conversationId: ROOT_CONVERSATION_ID, kind: "rejected" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		expect(await storage.mintId<EntryId>()).toBe(102);
		database.settle();
		await expect(rejected).rejects.toThrow("controlled settlement rejection");
		expect(await storage.mintId<EntryId>()).toBe(103);
		expect(await storage.entry(idFromNumber<EntryId>(200), BACKGROUND_CONTEXT)).toBeUndefined();
		await storage.close(BACKGROUND_CONTEXT);
	});
});
