import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "../src/core/extensions/index.ts";
import { handlePunchRequest } from "../src/extensions/punch/server.ts";
import { TodoStore } from "../src/extensions/punch/todo-store.ts";
import { applyTodoAction, installTodos, loadTodos, type TodoState } from "../src/extensions/punch/todos.ts";

type ContextHandler = ExtensionHandler<ContextEvent, ContextEventResult>;
type SessionStartHandler = ExtensionHandler<SessionStartEvent>;

interface ToolDefinition {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	execute?: (
		callId: string,
		args: Record<string, unknown>,
		_signal: unknown,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: unknown[]; details: unknown }>;
}

function emptyState(): TodoState {
	return { todos: [], nextId: 1, log: [] };
}

function stateWith(items: Array<{ id: number; text: string; done?: boolean }>): TodoState {
	const todos = items.map((item) => ({ id: item.id, text: item.text, done: item.done ?? false, createdAt: 1 }));
	return { todos, nextId: todos.length + 1, log: [] };
}

const stores: TodoStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function setup(store = new TodoStore(":memory:")) {
	stores.push(store);
	const handlers = new Map<string, unknown>();
	const tools: ToolDefinition[] = [];
	const setWidget = vi.fn();
	let sessionId = "session-one";
	const api = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	installTodos(api, store);

	const ctx = {
		hasUI: true,
		ui: { setWidget },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;

	return {
		api,
		ctx,
		store,
		setSessionId(id: string) {
			sessionId = id;
		},
		setWidget,
		tools,
		contextHandler: handlers.get("context") as ContextHandler,
		sessionStartHandler: handlers.get("session_start") as SessionStartHandler,
		todoTool: tools.find((candidate) => candidate.name === "todo"),
	};
}

describe("applyTodoAction", () => {
	it("adds items and returns a changed result", () => {
		const result = applyTodoAction(emptyState(), { action: "add", text: "write tests" });
		expect(result.changed).toBe(true);
		expect(result.state.todos).toEqual([{ id: 1, text: "write tests", done: false, createdAt: expect.any(Number) }]);
		expect(result.state.nextId).toBe(2);
		expect(result.state.log[0]?.summary).toBe("Added #1: write tests");
	});

	it("trims whitespace from added text", () => {
		const result = applyTodoAction(emptyState(), { action: "add", text: "  padded  " });
		expect(result.state.todos[0]?.text).toBe("padded");
	});

	it("rejects empty add text", () => {
		expect(() => applyTodoAction(emptyState(), { action: "add", text: "   " })).toThrow("text is required for add");
	});

	it("toggles items done and back", () => {
		let state = stateWith([{ id: 1, text: "step one" }]);
		state = applyTodoAction(state, { action: "toggle", id: 1 }).state;
		expect(state.todos[0]?.done).toBe(true);
		expect(state.log[0]?.summary).toBe("Completed #1: step one");
		state = applyTodoAction(state, { action: "toggle", id: 1 }).state;
		expect(state.todos[0]?.done).toBe(false);
		expect(state.log[0]?.summary).toBe("Reopened #1: step one");
	});

	it("rejects toggling a missing item", () => {
		expect(() => applyTodoAction(emptyState(), { action: "toggle", id: 99 })).toThrow("todo #99 not found");
	});

	it("requires an id for toggle, update, and split at the execute layer", async () => {
		const { todoTool, ctx } = setup();
		for (const action of ["toggle", "update", "split"]) {
			await expect(todoTool?.execute?.(`call-${action}`, { action }, undefined, undefined, ctx)).rejects.toThrow(
				`id is required for ${action}`,
			);
		}
	});

	it("updates item text", () => {
		const result = applyTodoAction(stateWith([{ id: 1, text: "old" }]), { action: "update", id: 1, text: "new" });
		expect(result.state.todos[0]?.text).toBe("new");
		expect(result.state.log[0]?.summary).toBe("Updated #1: new");
	});

	it("update with unchanged text is a no-op", () => {
		const before = stateWith([{ id: 1, text: "step" }]);
		const result = applyTodoAction(before, { action: "update", id: 1, text: "  step  " });
		expect(result.changed).toBe(false);
		expect(result.state).toBe(before);
		expect(result.state.log).toEqual([]);
	});

	it("splits an item into multiple items with fresh ids", () => {
		const result = applyTodoAction(stateWith([{ id: 1, text: "big task" }]), {
			action: "split",
			id: 1,
			parts: ["part a", "part b", "part c"],
		});
		expect(result.state.todos.map((todo) => todo.text)).toEqual(["part a", "part b", "part c"]);
		expect(result.state.todos.map((todo) => todo.id)).toEqual([2, 3, 4]);
		expect(result.state.nextId).toBe(5);
		expect(result.state.log[0]?.summary).toBe("Split #1 into 3 items");
	});

	it("rejects split with fewer than two parts", () => {
		expect(() =>
			applyTodoAction(stateWith([{ id: 1, text: "big" }]), { action: "split", id: 1, parts: ["only"] }),
		).toThrow("split requires at least two parts");
	});

	it("clears all items", () => {
		const result = applyTodoAction(
			stateWith([
				{ id: 1, text: "a" },
				{ id: 2, text: "b" },
			]),
			{ action: "clear" },
		);
		expect(result.state.todos).toEqual([]);
		expect(result.state.log[0]?.summary).toBe("Cleared plan");
	});

	it("list is a no-op that does not touch state or the log", () => {
		const before = stateWith([{ id: 1, text: "a" }]);
		const result = applyTodoAction(before, { action: "list" });
		expect(result.changed).toBe(false);
		expect(result.state).toBe(before);
		expect(result.state.log).toEqual([]);
		expect(result.text).toContain("[ ] #1 a");
	});

	it("keeps the log bounded", () => {
		let state = emptyState();
		for (let i = 0; i < 15; i += 1) {
			state = applyTodoAction(state, { action: "add", text: `item ${i}` }).state;
		}
		expect(state.log.length).toBe(10);
		expect(state.log[0]?.summary).toBe("Added #15: item 14");
	});
});

describe("legacy JSON parsing", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "punch-todos-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty state for a missing file", () => {
		expect(loadTodos(join(dir, "missing.json"))).toEqual(emptyState());
	});

	it("returns an empty state for corrupt json", () => {
		const file = join(dir, "todos.json");
		writeFileSync(file, "{ not json");
		expect(loadTodos(file)).toEqual(emptyState());
	});

	it("drops invalid todo and log entries and fixes nextId", () => {
		const file = join(dir, "todos.json");
		writeFileSync(
			file,
			JSON.stringify({
				todos: [
					{ id: 2, text: "missing done", createdAt: 1 },
					{ id: "3", text: "string id", done: false, createdAt: 1 },
					{ id: 4, text: "ok", done: true, createdAt: 1 },
					null,
				],
				nextId: 1,
				log: [{ at: 1, summary: "good" }, { summary: "missing at" }, null, "not an object"],
			}),
		);
		const state = loadTodos(file);
		expect(state.todos).toEqual([{ id: 4, text: "ok", done: true, createdAt: 1 }]);
		expect(state.nextId).toBe(5);
		expect(state.log).toEqual([{ at: 1, summary: "good" }]);
	});

	it("drops out-of-range numeric fields and non-safe nextId", () => {
		const file = join(dir, "todos.json");
		writeFileSync(
			file,
			'{"todos":[{"id":1e400,"text":"infinite id","done":false,"createdAt":1},{"id":1,"text":"infinite createdAt","done":false,"createdAt":1e400},{"id":2,"text":"ok","done":false,"createdAt":3}],"nextId":1,"log":[{"at":1e400,"summary":"infinite at"},{"at":2,"summary":"ok"}]}',
		);
		const state = loadTodos(file);
		expect(state.todos).toEqual([{ id: 2, text: "ok", done: false, createdAt: 3 }]);
		expect(state.nextId).toBe(3);
		expect(state.log).toEqual([{ at: 2, summary: "ok" }]);
	});

	it("repairs a non-safe nextId to maxId + 1 on an empty plan", () => {
		const file = join(dir, "todos.json");
		writeFileSync(file, '{"todos":[],"nextId":1e400,"log":[]}');
		const state = loadTodos(file);
		expect(state).toEqual(emptyState());
		expect(state.nextId).toBe(1);
	});

	it("drops duplicate ids keeping the first occurrence", () => {
		const file = join(dir, "todos.json");
		writeFileSync(
			file,
			JSON.stringify({
				todos: [
					{ id: 1, text: "first", done: false, createdAt: 1 },
					{ id: 1, text: "conflicting", done: true, createdAt: 2 },
					{ id: 2, text: "second", done: false, createdAt: 3 },
				],
				nextId: 3,
				log: [],
			}),
		);
		const state = loadTodos(file);
		expect(state.todos).toEqual([
			{ id: 1, text: "first", done: false, createdAt: 1 },
			{ id: 2, text: "second", done: false, createdAt: 3 },
		]);
		expect(state.nextId).toBe(3);
	});

	it("repairs a non-safe nextId without dropping valid todos", () => {
		const file = join(dir, "todos.json");
		writeFileSync(file, '{"todos":[{"id":7,"text":"keep me","done":false,"createdAt":1}],"nextId":1e400,"log":[]}');
		const state = loadTodos(file);
		expect(state.todos).toEqual([{ id: 7, text: "keep me", done: false, createdAt: 1 }]);
		expect(state.nextId).toBe(8);
	});
});

describe("TodoStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "punch-todo-store-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists ordered tasks across connections and isolates sessions", () => {
		const path = join(dir, "todos.sqlite");
		const first = new TodoStore(path);
		stores.push(first);
		first.apply("thread-one", { action: "add", text: "first" });
		first.apply("thread-one", { action: "add", text: "second" });
		first.apply("thread-two", { action: "add", text: "other" });
		const reopened = new TodoStore(path);
		stores.push(reopened);
		expect(reopened.load("thread-one").todos.map((item) => item.text)).toEqual(["first", "second"]);
		expect(reopened.load("thread-two").todos.map((item) => item.text)).toEqual(["other"]);
		expect(reopened.load("thread-two").todos[0]?.id).toBe(1);
	});

	it("serializes read-modify-write actions from independent connections", () => {
		const path = join(dir, "todos.sqlite");
		const first = new TodoStore(path);
		const second = new TodoStore(path);
		stores.push(first, second);
		first.apply("thread", { action: "add", text: "first" });
		second.apply("thread", { action: "add", text: "second" });
		first.apply("thread", { action: "split", id: 1, parts: ["a", "b"] });
		expect(second.load("thread").todos.map((item) => [item.id, item.text])).toEqual([
			[3, "a"],
			[4, "b"],
			[2, "second"],
		]);
	});

	it("deletes only the selected session and does not reimport its old tasks", () => {
		const path = join(dir, "todos.sqlite");
		const legacy = join(dir, "todos.json");
		writeFileSync(
			legacy,
			JSON.stringify({ todos: [{ id: 7, text: "old", done: false, createdAt: 1 }], nextId: 8, log: [] }),
		);
		const store = new TodoStore(path, legacy);
		stores.push(store);
		store.migrateLegacy("thread-one");
		store.apply("thread-two", { action: "add", text: "other" });
		expect(store.load("thread-one").todos[0]?.text).toBe("old");
		store.delete("thread-one");
		store.migrateLegacy("thread-one");
		expect(store.load("thread-one")).toEqual(emptyState());
		expect(() => store.apply("thread-one", { action: "add", text: "late write" })).toThrow(
			"Session tasks were deleted",
		);
		expect(store.load("thread-two").todos[0]?.text).toBe("other");
	});

	it("reset prevents an unmigrated legacy list from appearing in the next session", () => {
		const legacy = join(dir, "todos.json");
		writeFileSync(
			legacy,
			JSON.stringify({ todos: [{ id: 1, text: "old", done: false, createdAt: 1 }], nextId: 2, log: [] }),
		);
		const store = new TodoStore(join(dir, "todos.sqlite"), legacy);
		stores.push(store);
		store.delete("old-session");
		store.migrateLegacy("new-session");
		expect(store.load("new-session")).toEqual(emptyState());
	});

	it("keeps a malformed legacy file available for a later migration attempt", () => {
		const legacy = join(dir, "todos.json");
		writeFileSync(legacy, "{broken");
		const store = new TodoStore(join(dir, "todos.sqlite"), legacy);
		stores.push(store);
		expect(() => store.migrateLegacy("session")).toThrow();
		writeFileSync(
			legacy,
			JSON.stringify({ todos: [{ id: 1, text: "recovered", done: false, createdAt: 1 }], nextId: 2, log: [] }),
		);
		store.migrateLegacy("session");
		expect(store.load("session").todos[0]?.text).toBe("recovered");
	});
});

describe("todo API", () => {
	it("requires authentication and deletes only the requested session", async () => {
		const previousPassword = process.env.PI_SERVER_PASSWORD;
		process.env.PI_SERVER_PASSWORD = "test-password";
		const store = new TodoStore(":memory:");
		stores.push(store);
		store.apply("first", { action: "add", text: "first task" });
		store.apply("second", { action: "add", text: "second task" });
		const server = createServer((req, res) => {
			void handlePunchRequest(req, res, store);
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP address");
			const base = `http://127.0.0.1:${address.port}`;
			expect((await fetch(`${base}/todos/first`)).status).toBe(401);
			const headers = { authorization: `Basic ${Buffer.from("opencode:test-password").toString("base64")}` };
			const before = await fetch(`${base}/todos/first`, { headers });
			expect(before.status).toBe(200);
			const body = (await before.json()) as { todos: Array<{ text: string }> };
			expect(body.todos[0]?.text).toBe("first task");
			expect((await fetch(`${base}/todos/first`, { method: "DELETE", headers })).status).toBe(200);
			expect(store.load("first")).toEqual(emptyState());
			expect(store.load("second").todos[0]?.text).toBe("second task");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			if (previousPassword === undefined) delete process.env.PI_SERVER_PASSWORD;
			else process.env.PI_SERVER_PASSWORD = previousPassword;
		}
	});
});

describe("installTodos", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "punch-todos-"));
		process.env.PI_DATA_DIR = dir;
	});

	afterEach(() => {
		delete process.env.PI_DATA_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("registers a todo tool with guidelines", () => {
		const { todoTool } = setup();
		expect(todoTool).toBeDefined();
		expect(todoTool?.promptSnippet).toBe("Track your plan with the todo tool");
		expect(todoTool?.promptGuidelines).toContain("Check the plan before every next action; keep it current.");
	});

	it("injects nothing when the plan is empty", async () => {
		const { contextHandler, todoTool, ctx } = setup();
		const result = await todoTool?.execute?.("call-0", { action: "list" }, undefined, undefined, ctx);
		expect(result?.content[0]).toEqual({ type: "text", text: "Plan is empty." });
		expect(await contextHandler?.({ type: "context", messages: [] }, ctx)).toBeUndefined();
	});

	it("injects the plan into context before each call", async () => {
		const { contextHandler, todoTool, ctx } = setup();
		await todoTool?.execute?.("call-1", { action: "add", text: "step one" }, undefined, undefined, ctx);
		const result = await contextHandler?.({ type: "context", messages: [] }, ctx);
		expect(result?.messages?.length).toBe(1);
		const message = result?.messages?.[0];
		expect(message?.role).toBe("custom");
		expect((message as { customType?: string }).customType).toBe("punch-todo-context");
		expect((message as { display?: boolean }).display).toBe(false);
		expect((message as { content?: string }).content).toContain("[Punch plan]");
		expect((message as { content?: string }).content).toContain("[ ] #1 step one");
	});

	it("persists mutations through the tool", async () => {
		const { todoTool, ctx, store } = setup(new TodoStore(join(dir, "todos.sqlite")));
		await todoTool?.execute?.("call-1", { action: "add", text: "step one" }, undefined, undefined, ctx);
		await todoTool?.execute?.("call-2", { action: "add", text: "step two" }, undefined, undefined, ctx);
		expect(store.load("session-one").todos.map((todo) => todo.text)).toEqual(["step one", "step two"]);
	});

	it("updates the widget only when the plan changes", async () => {
		const { setWidget, todoTool, ctx } = setup();
		await todoTool?.execute?.("call-1", { action: "add", text: "step one" }, undefined, undefined, ctx);
		expect(setWidget).toHaveBeenCalledWith("punch-todos", expect.arrayContaining(["[ ] #1 step one"]));
		const callCount = setWidget.mock.calls.length;
		await todoTool?.execute?.("call-2", { action: "list" }, undefined, undefined, ctx);
		await todoTool?.execute?.("call-3", { action: "update", id: 1, text: "step one" }, undefined, undefined, ctx);
		expect(setWidget.mock.calls.length).toBe(callCount);
	});

	it("loads the active session on session start", async () => {
		const { sessionStartHandler, todoTool, ctx, setWidget, setSessionId, store } = setup();
		await todoTool?.execute?.("call-1", { action: "add", text: "step one" }, undefined, undefined, ctx);
		store.apply("session-two", { action: "add", text: "step two" });
		setSessionId("session-two");
		setWidget.mockClear();
		sessionStartHandler?.({ type: "session_start", reason: "startup" }, ctx);
		expect(setWidget).toHaveBeenCalledWith("punch-todos", ["[ ] #1 step two", "last: Added #1: step two"]);
	});
});
