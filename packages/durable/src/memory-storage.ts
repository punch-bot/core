import type { Context, JsonValue } from "@punch-bot/chord";
import type {
	ConversationRecord,
	Cursor,
	EntryQuery,
	EntryRecord,
	Id,
	Input,
	Page,
	Seq,
	Storage,
	StorageWrite,
	TaskQuery,
	TaskRecord,
} from "./types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "input";

type State = {
	conversations: Map<Id, ConversationRecord>;
	entries: Map<Id, EntryRecord>;
	entryIds: Map<Id, Id[]>;
	entryCommitSeqs: Map<Id, Seq>;
	tasks: Map<Id, StoredTask>;
	inputs: Map<Id, Input>;
};

/** Clone trusted JSON containers while sharing immutable primitives. */
const clone = <T>(value: T): T => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	const source = value as Record<string, unknown>;
	const nullPrototype = Object.getPrototypeOf(value) === null;
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const copied = clone(source[key]);
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			result[key] = copied;
		}
	}
	return result as T;
};

const cursorId = (cursor: Readonly<Record<string, JsonValue>> | undefined): Id | undefined =>
	cursor?.after as Id | undefined;

const tableContaining = (state: State, id: Id): TableName | undefined => {
	if (state.conversations.has(id)) return "conversation";
	if (state.entries.has(id)) return "entry";
	if (state.tasks.has(id)) return "task";
	if (state.inputs.has(id)) return "input";
	return undefined;
};

const page = <T extends { readonly id: Id }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items: clone(items) };
	return { items: clone(items), next: { after: items.at(-1)!.id } };
};

export class MemoryStorage implements Storage {
	private readonly state: State = {
		conversations: new Map(),
		entries: new Map(),
		entryIds: new Map(),
		entryCommitSeqs: new Map(),
		tasks: new Map(),
		inputs: new Map(),
	};
	private nextId = 2;
	private nextSeq = 1;
	private closed = false;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const prepared = writes.map((write) => clone(write));
		this.checkImmutableIds(prepared);
		const seq = this.nextSeq;

		for (const write of prepared) {
			switch (write.type) {
				case "conversation":
					this.state.conversations.set(write.value.id, write.value);
					break;
				case "entry": {
					this.state.entries.set(write.value.id, write.value);
					this.state.entryCommitSeqs.set(write.value.id, seq);
					let ids = this.state.entryIds.get(write.value.conversationId);
					if (ids === undefined) {
						ids = [];
						this.state.entryIds.set(write.value.conversationId, ids);
					}
					let low = 0;
					let high = ids.length;
					while (low < high) {
						const middle = (low + high) >>> 1;
						if (ids[middle] < write.value.id) low = middle + 1;
						else high = middle;
					}
					ids.splice(low, 0, write.value.id);
					break;
				}
				case "task":
					this.state.tasks.set(write.value.id, write.value);
					break;
				case "input":
					this.state.inputs.set(write.value.id, write.value);
					break;
			}
			this.nextId = Math.max(this.nextId, write.value.id + 1);
		}
		this.nextSeq++;
		return seq;
	}

	mintId(): Id {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++;
	}

	async conversation(id: Id, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const values = [...this.state.conversations.values()]
			.filter((value) => after === undefined || value.id > after)
			.sort((left, right) => left.id - right.id);
		return page(values, limit);
	}

	async entry(
		id: Id,
		_context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		const entry = this.state.entries.get(id);
		if (entry === undefined) return undefined;
		return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
	}

	async findLatestHeadMarker(
		conversationId: Id,
		atOrBeforeEntryId: Id | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: Id }) | undefined> {
		this.assertOpen();
		for (const entry of this.visibleEntries(conversationId, undefined, atOrBeforeEntryId)) {
			if (entry.head !== undefined) return clone({ ...entry, head: entry.head });
		}
		return undefined;
	}

	async scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const maxEntryId =
			after === undefined ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
		const visible: EntryRecord[] = [];
		for (const entry of this.visibleEntries(query.conversationId, query.minEntryId, maxEntryId)) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		return page(visible, limit);
	}

	async task(id: Id, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const values = [...this.state.tasks.values()]
			.filter((value) => after === undefined || value.id > after)
			.filter((value) => query.conversationId === undefined || value.conversationId === query.conversationId)
			.filter((value) => query.kind === undefined || value.kind === query.kind)
			.filter((value) => query.status === undefined || value.state.status === query.status)
			.filter((value) => query.abortRequested === undefined || value.abortRequested === query.abortRequested)
			.filter((value) => query.background === undefined || value.background === query.background)
			.sort((left, right) => left.id - right.id);
		return page(values, limit);
	}

	async input(id: Id, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		const value = this.state.inputs.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async inputByRequest(conversationId: Id, requestId: string, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		for (const value of this.state.inputs.values()) {
			if (value.conversationId === conversationId && value.requestId === requestId) return clone(value);
		}
		return undefined;
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private *visibleEntries(
		conversationId: Id,
		minEntryId = Number.NEGATIVE_INFINITY,
		maxEntryId = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = maxEntryId;
		const visited = new Set<Id>();
		while (true) {
			if (visited.has(currentId)) throw new Error("Conversation parent cycle");
			visited.add(currentId);
			const ids = this.state.entryIds.get(currentId) ?? [];
			let low = 0;
			let high = ids.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (ids[middle] <= upperEntryId) low = middle + 1;
				else high = middle;
			}
			for (let index = low - 1; index >= 0; index--) {
				const id = ids[index];
				if (id < minEntryId) break;
				yield this.state.entries.get(id)!;
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
	}

	private checkImmutableIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id, TableName>();
		for (const write of writes) {
			const table = write.type;
			const id = write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
