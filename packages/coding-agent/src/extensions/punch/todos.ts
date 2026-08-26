import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentMessage } from "@punch-bot/agent";
import { StringEnum } from "@punch-bot/ai";
import { Type } from "typebox";

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const MAX_LOG = 10;

export interface TodoItem {
	id: number;
	text: string;
	done: boolean;
	createdAt: number;
}

export interface TodoLogEntry {
	at: number;
	summary: string;
}

export interface TodoState {
	todos: TodoItem[];
	nextId: number;
	log: TodoLogEntry[];
}

export type TodoAction =
	| { action: "list" }
	| { action: "add"; text: string }
	| { action: "toggle"; id: number }
	| { action: "update"; id: number; text: string }
	| { action: "split"; id: number; parts: string[] }
	| { action: "clear" };

export interface TodoActionResult {
	state: TodoState;
	text: string;
	changed: boolean;
}

function emptyState(): TodoState {
	return { todos: [], nextId: 1, log: [] };
}

export function todosFile(): string {
	return join(process.env.PI_DATA_DIR || join(process.cwd(), ".pi"), "todos.json");
}

export function loadTodos(file = todosFile()): TodoState {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TodoState>;
		if (!Array.isArray(parsed.todos) || typeof parsed.nextId !== "number" || !Array.isArray(parsed.log)) {
			return emptyState();
		}
		return {
			todos: parsed.todos as TodoItem[],
			nextId: parsed.nextId,
			log: parsed.log as TodoLogEntry[],
		};
	} catch {
		return emptyState();
	}
}

export function saveTodos(state: TodoState, file = todosFile()): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

function appendLog(state: TodoState, summary: string): TodoState {
	const log = [{ at: Date.now(), summary }, ...state.log].slice(0, MAX_LOG);
	return { ...state, log };
}

function formatPlan(state: TodoState): string {
	if (state.todos.length === 0) return "Plan is empty.";
	const pending = state.todos.filter((todo) => !todo.done);
	const done = state.todos.filter((todo) => todo.done);
	return [...pending, ...done].map((todo) => `${todo.done ? "[x]" : "[ ]"} #${todo.id} ${todo.text}`).join("\n");
}

function formatRecentChanges(state: TodoState, limit = 3): string {
	if (state.log.length === 0) return "";
	return `Recent changes:\n${state.log
		.slice(0, limit)
		.map((entry) => `- ${entry.summary}`)
		.join("\n")}`;
}

function contextInjection(state: TodoState): string {
	const plan = formatPlan(state);
	const changes = formatRecentChanges(state);
	const directive =
		"Check this plan before your next action; update it with the todo tool when work is done or scope changes (add, split, or revise).";
	return changes ? `[Punch plan]\n${plan}\n\n${changes}\n\n${directive}` : `[Punch plan]\n${plan}\n\n${directive}`;
}

export function applyTodoAction(state: TodoState, action: TodoAction): TodoActionResult {
	switch (action.action) {
		case "list": {
			return { state, text: formatPlan(state), changed: false };
		}
		case "add": {
			const text = action.text.trim();
			if (!text) throw new Error("text is required for add");
			const item: TodoItem = { id: state.nextId, text, done: false, createdAt: Date.now() };
			const next = appendLog(
				{ ...state, todos: [...state.todos, item], nextId: state.nextId + 1 },
				`Added #${item.id}: ${text}`,
			);
			return { state: next, text: formatPlan(next), changed: true };
		}
		case "toggle": {
			const index = state.todos.findIndex((todo) => todo.id === action.id);
			if (index === -1) throw new Error(`todo #${action.id} not found`);
			const todos = [...state.todos];
			todos[index] = { ...todos[index]!, done: !todos[index]!.done };
			const item = todos[index]!;
			const summary = item.done ? `Completed #${item.id}: ${item.text}` : `Reopened #${item.id}: ${item.text}`;
			const next = appendLog({ ...state, todos }, summary);
			return { state: next, text: formatPlan(next), changed: true };
		}
		case "update": {
			const index = state.todos.findIndex((todo) => todo.id === action.id);
			if (index === -1) throw new Error(`todo #${action.id} not found`);
			const text = action.text.trim();
			if (!text) throw new Error("text is required for update");
			const todos = [...state.todos];
			todos[index] = { ...todos[index]!, text };
			const next = appendLog({ ...state, todos }, `Revised #${action.id}: ${text}`);
			return { state: next, text: formatPlan(next), changed: true };
		}
		case "split": {
			const index = state.todos.findIndex((todo) => todo.id === action.id);
			if (index === -1) throw new Error(`todo #${action.id} not found`);
			const parts = action.parts.map((part) => part.trim()).filter(Boolean);
			if (parts.length < 2) throw new Error("split requires at least two parts");
			const createdAt = Date.now();
			const created: TodoItem[] = parts.map((part, offset) => ({
				id: state.nextId + offset,
				text: part,
				done: false,
				createdAt,
			}));
			const todos = [...state.todos.slice(0, index), ...created, ...state.todos.slice(index + 1)];
			const next = appendLog(
				{ ...state, todos, nextId: state.nextId + created.length },
				`Split #${action.id} into ${created.length} items`,
			);
			return { state: next, text: formatPlan(next), changed: true };
		}
		case "clear": {
			if (state.todos.length === 0) return { state, text: formatPlan(state), changed: false };
			const next = appendLog({ ...state, todos: [] }, "Cleared plan");
			return { state: next, text: formatPlan(next), changed: true };
		}
	}
}

export function installTodos(pi: ExtensionAPI): void {
	let state = loadTodos();

	const syncWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (state.todos.length === 0) {
			ctx.ui.setWidget("punch-todos", undefined);
			return;
		}
		const pending = state.todos.filter((todo) => !todo.done).map((todo) => `[ ] #${todo.id} ${todo.text}`);
		const done = state.todos.filter((todo) => todo.done).map((todo) => `[x] #${todo.id} ${todo.text}`);
		const lines = [...pending, ...done];
		if (state.log[0]) lines.push(`last: ${state.log[0].summary}`);
		ctx.ui.setWidget("punch-todos", lines);
	};

	pi.on("session_start", (_event, ctx) => {
		state = loadTodos();
		syncWidget(ctx);
	});

	pi.on("context", (event) => {
		if (state.todos.length === 0) return;
		const message: AgentMessage = {
			role: "custom",
			customType: "punch-todo-context",
			content: contextInjection(state),
			display: false,
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, message] };
	});

	pi.registerTool({
		name: "todo",
		label: "Punch to-do list",
		description: "Maintain a live to-do plan: list, add, mark done, revise, split, or clear items.",
		promptSnippet: "Track your plan with the todo tool",
		promptGuidelines: [
			"Before starting a multi-step task, create a plan with todo (action=add) for each step.",
			"Check the plan before every next action; keep it current.",
			"Mark items done (action=toggle) as soon as they finish.",
			"When scope changes, add, split, or revise items.",
			"Do not call todo when nothing changed.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "toggle", "update", "split", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Item text for add or update" })),
			id: Type.Optional(Type.Number({ description: "Item id for toggle, update, or split" })),
			parts: Type.Optional(Type.Array(Type.String({ description: "New items for split" }))),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			let action: TodoAction;
			switch (args.action) {
				case "list":
					action = { action: "list" };
					break;
				case "add":
					action = { action: "add", text: args.text ?? "" };
					break;
				case "toggle":
					action = { action: "toggle", id: args.id ?? 0 };
					break;
				case "update":
					action = { action: "update", id: args.id ?? 0, text: args.text ?? "" };
					break;
				case "split":
					action = { action: "split", id: args.id ?? 0, parts: args.parts ?? [] };
					break;
				case "clear":
					action = { action: "clear" };
					break;
			}
			const result = applyTodoAction(state, action);
			state = result.state;
			if (result.changed) {
				saveTodos(state);
				syncWidget(ctx);
			}
			const changes = formatRecentChanges(result.state);
			const text = changes ? `${result.text}\n\n${changes}` : result.text;
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
