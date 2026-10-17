import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@punch-bot/agent";
import { streamSimple } from "@punch-bot/ai/compat";
import { getBuiltinModels } from "@punch-bot/ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/core/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const base = getBuiltinModels("openrouter").find((model) => !model.id.includes(":"))!;

async function startRpcMode(): Promise<{
	send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const tempDir = join(tmpdir(), `pi-rpc-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const authStorage = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } });
	const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(authStorage));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: base, systemPrompt: "Test", tools: [] },
			streamFn: streamSimple,
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	let nextId = 0;
	const send = async (command: Record<string, unknown>) => {
		const id = `req-${nextId++}`;
		rpcIo.lineHandler!(JSON.stringify({ ...command, id }));
		return vi.waitFor(() => {
			const response = rpcIo.outputLines
				.flatMap((line) => line.split("\n"))
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.find((record) => record.id === id && record.type === "response");
			expect(response).toBeDefined();
			return response!;
		});
	};

	return {
		send,
		cleanup: async () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

describe("RPC model commands with suffix variants", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("resolve_model returns the suffixed model without changing the session's model", async () => {
		const { send, cleanup } = await startRpcMode();
		try {
			const modelId = `${base.id}:floor`;
			expect(await send({ type: "resolve_model", provider: "openrouter", modelId })).toMatchObject({
				command: "resolve_model",
				success: true,
				data: { provider: "openrouter", id: modelId, name: `${base.name} (floor)`, api: base.api },
			});
			expect(await send({ type: "get_state" })).toMatchObject({ data: { model: { id: base.id } } });
		} finally {
			await cleanup();
		}
	});

	it("resolve_model fails with the same error as set_model", async () => {
		const { send, cleanup } = await startRpcMode();
		try {
			// An unknown base, a thinking level, and an empty suffix are not suffix variants
			for (const modelId of ["vendor/missing:floor", `${base.id}:high`, `${base.id}:`]) {
				const error = `Model not found: openrouter/${modelId}`;
				const command = { provider: "openrouter", modelId };
				expect(await send({ type: "resolve_model", ...command })).toMatchObject({ success: false, error });
				expect(await send({ type: "set_model", ...command })).toMatchObject({ success: false, error });
			}
			expect(await send({ type: "get_state" })).toMatchObject({ data: { model: { id: base.id } } });
		} finally {
			await cleanup();
		}
	});

	it("set_model selects a suffixed model that get_available_models does not list", async () => {
		const { send, cleanup } = await startRpcMode();
		try {
			const modelId = `${base.id}:nitro:exacto`;
			expect(await send({ type: "set_model", provider: "openrouter", modelId })).toMatchObject({
				success: true,
				data: { id: modelId },
			});
			expect(await send({ type: "get_state" })).toMatchObject({ data: { model: { id: modelId } } });
			const available = await send({ type: "get_available_models" });
			const ids = (available.data as { models: { id: string }[] }).models.map((model) => model.id);
			expect(ids).toContain(base.id);
			expect(ids).not.toContain(modelId);
		} finally {
			await cleanup();
		}
	});
});
