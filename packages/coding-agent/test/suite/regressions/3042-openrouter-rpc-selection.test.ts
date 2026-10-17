import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@punch-bot/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { defaultModelPerProvider } from "../../../src/core/model-resolver.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { stopThemeWatcher } from "../../../src/core/theme/theme.ts";
import { main } from "../../../src/main.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	responses: [] as RpcResponse[],
	hosts: [] as AgentSessionRuntime[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	ready: undefined as (() => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: () => {},
	restoreStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => {
		rpcIo.responses.push(JSON.parse(line) as RpcResponse);
	},
}));

vi.mock("../../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, handler: (line: string) => void) => {
		rpcIo.lineHandler = handler;
		rpcIo.ready?.();
		return () => {
			rpcIo.lineHandler = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

vi.mock("../../../src/modes/index.ts", () => ({
	runRpcMode: (host: AgentSessionRuntime) => {
		rpcIo.hosts.push(host);
		return runRpcMode(host);
	},
}));

describe("regression #3042: OpenRouter RPC startup and session selection", () => {
	let harness: Harness;
	let agentDir: string;
	let requestId: number;
	let diagnostics: string[];
	let endListeners: ReturnType<typeof process.stdin.listeners>;
	let signalListeners: Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>;

	beforeEach(async () => {
		harness = await createHarness({ models: [{ id: "fixture/model", reasoning: true }] });
		agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir);
		writeCatalog(["fixture/model", "fixture/model:free", "fixture/model:batch"]);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "openrouter", defaultModel: "fixture/model" }),
		);
		requestId = 0;
		diagnostics = [];
		endListeners = process.stdin.listeners("end");
		signalListeners = new Map(
			(["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, new Set(process.listeners(signal))]),
		);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(process, "cwd").mockReturnValue(harness.tempDir);
		vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			diagnostics.push(String(message));
		});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error(diagnostics.join("\n"));
		});
	});

	afterEach(async () => {
		for (const host of rpcIo.hosts) await host.dispose();
		for (const listener of process.stdin.listeners("end")) {
			if (!endListeners.includes(listener)) process.stdin.off("end", listener as () => void);
		}
		for (const [signal, previous] of signalListeners) {
			for (const listener of process.listeners(signal)) {
				if (!previous.has(listener)) process.off(signal, listener);
			}
		}
		stopThemeWatcher();
		rpcIo.responses = [];
		rpcIo.hosts = [];
		rpcIo.lineHandler = undefined;
		rpcIo.ready = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	function writeCatalog(ids: string[]) {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					openrouter: {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						apiKey: "faux-key",
						models: ids.map((id) => ({ ...harness.getModel(), id, api: "openai-completions", name: id })),
					},
				},
			}),
		);
	}

	function savedSession(modelId: string) {
		const manager = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		manager.appendModelChange("openrouter", modelId);
		manager.appendMessage({ ...fauxAssistantMessage("saved"), provider: "openrouter", model: modelId });
		return manager.getSessionFile()!;
	}

	async function start(args: string[] = []) {
		const ready = new Promise<void>((resolve) => {
			rpcIo.ready = resolve;
		});
		await Promise.race([ready, main(["--mode", "rpc", "--offline", "-ne", ...args])]);
		return async (command: RpcCommand): Promise<RpcResponse> => {
			const id = String(++requestId);
			rpcIo.lineHandler?.(JSON.stringify({ ...command, id }));
			await vi.waitFor(() => expect(rpcIo.responses.some((response) => response.id === id)).toBe(true));
			return rpcIo.responses.find((response) => response.id === id)!;
		};
	}

	it("starts with and switches to exactly the requested variant", async () => {
		const request = await start(["--provider", "openrouter", "--model", "fixture/model:free"]);
		expect(await request({ type: "get_state" })).toMatchObject({
			success: true,
			data: { model: { provider: "openrouter", id: "fixture/model:free" } },
		});
		for (const modelId of ["fixture/model:batch", "fixture/model:free", "fixture/model:nitro", "fixture/model"]) {
			expect(await request({ type: "set_model", provider: "openrouter", modelId })).toMatchObject({
				success: true,
				data: { id: modelId },
			});
		}
		// RPC never matches partially, and a thinking level is not a variant suffix
		for (const modelId of ["fixture/model:free:high", "model", "fixture/missing"]) {
			expect(await request({ type: "set_model", provider: "openrouter", modelId })).toMatchObject({
				success: false,
				error: expect.stringContaining("Model not found"),
			});
		}
		expect(await request({ type: "set_model", provider: "unknown", modelId: "fixture/model" })).toMatchObject({
			success: false,
		});
		expect(await request({ type: "get_state" })).toMatchObject({
			data: { model: { provider: "openrouter", id: "fixture/model" } },
		});
	});

	it("parses startup thinking after a service variant and honors --thinking", async () => {
		const request = await start(["--model", "openrouter/fixture/model:free:high", "--thinking", "low"]);
		expect(await request({ type: "get_state" })).toMatchObject({
			success: true,
			data: { model: { id: "fixture/model:free" }, thinkingLevel: "low" },
		});
	});

	it.each([{ args: ["--model", "openrouter/fixture/model"] }, { args: ["--models", "openrouter/fixture/model"] }])(
		"names the variant a partial match picks when the base is missing, with flags $args",
		async ({ args }) => {
			writeCatalog(["fixture/model:free"]);
			const request = await start(args);
			expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model:free" } } });
			expect(diagnostics.join("\n")).toContain(
				'No exact match for "openrouter/fixture/model". Using openrouter/fixture/model:free.',
			);
		},
	);

	it("names the model it uses when the saved default is missing", async () => {
		writeCatalog(["fixture/model:free"]);
		const request = await start();
		const fallback = defaultModelPerProvider.openrouter;
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: fallback } } });
		expect(diagnostics.join("\n")).toContain(
			`Could not select default model openrouter/fixture/model (model not found). Using openrouter/${fallback}.`,
		);
	});

	it("rejects an empty explicit model instead of using the default", async () => {
		await expect(start(["--model", ""])).rejects.toThrow('Model "" not found');
		expect(rpcIo.hosts).toEqual([]);
	});

	it("warns instead of failing startup for a stale enabledModels setting", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "openrouter",
				defaultModel: "fixture/model",
				enabledModels: ["openrouter/fixture/missing", "openrouter/fixture/model:free"],
			}),
		);
		const request = await start();
		expect(await request({ type: "get_state" })).toMatchObject({
			success: true,
			data: { model: { id: "fixture/model:free" } },
		});
		expect(diagnostics.join("\n")).toContain("openrouter/fixture/missing");
	});

	it("restores the destination session's model instead of the startup --model on switch", async () => {
		const variant = savedSession("fixture/model:free");
		const missing = savedSession("fixture/missing");
		const request = await start(["--model", "openrouter/fixture/model"]);
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model" } } });
		expect(await request({ type: "switch_session", sessionPath: variant })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model:free" } } });
		// A session whose model is gone falls back to the default instead of the startup --model
		expect(await request({ type: "switch_session", sessionPath: missing })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({
			data: { sessionFile: missing, model: { id: "fixture/model" } },
		});
		expect(await request({ type: "new_session" })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model" } } });
	});

	it("switches to a saved session even when the startup model was removed from the catalog", async () => {
		const variant = savedSession("fixture/model:free");
		// Start while fixture/model is still in the catalog, then drop it before switching.
		const request = await start(["--model", "openrouter/fixture/model"]);
		writeCatalog(["fixture/model:free"]);
		expect(await request({ type: "switch_session", sessionPath: variant })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model:free" } } });
	});

	it("restores a model-only session instead of the first enabledModels entry", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "openrouter",
				defaultModel: "fixture/model",
				enabledModels: ["openrouter/fixture/model:batch"],
			}),
		);
		// SessionManager does not write a session file until an assistant message exists, so write the
		// header and model_change entry in the on-disk JSONL format directly.
		const sessionPath = join(harness.tempDir, "model-only.jsonl");
		const entries = [
			{ type: "session", version: 3, id: "model-only", timestamp: "2026-08-03T00:00:00.000Z", cwd: harness.tempDir },
			{
				type: "model_change",
				id: "model-change",
				parentId: null,
				timestamp: "2026-08-03T00:00:01.000Z",
				provider: "openrouter",
				modelId: "fixture/model:free",
			},
		];
		writeFileSync(sessionPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		const request = await start(["--session", sessionPath]);
		expect(await request({ type: "get_state" })).toMatchObject({
			data: { sessionFile: sessionPath, model: { id: "fixture/model:free" } },
		});
	});

	it("restores variants on startup and switch, including routing suffixes", async () => {
		const variant = savedSession("fixture/model:free");
		const routed = savedSession("fixture/model:nitro");
		const request = await start(["--session", variant]);
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model:free" } } });
		expect(await request({ type: "new_session" })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: "fixture/model" } } });
		expect(await request({ type: "switch_session", sessionPath: routed })).toMatchObject({ success: true });
		expect(await request({ type: "get_state" })).toMatchObject({
			data: { sessionFile: routed, model: { id: "fixture/model:nitro" } },
		});
	});

	it("warns instead of restoring a variant when the saved base is missing", async () => {
		const sessionPath = savedSession("fixture/model");
		writeCatalog(["fixture/model:free"]);
		const request = await start(["--session", sessionPath]);
		const fallback = defaultModelPerProvider.openrouter;
		expect(await request({ type: "get_state" })).toMatchObject({ data: { model: { id: fallback } } });
		expect(diagnostics.join("\n")).toContain(
			`Could not restore model openrouter/fixture/model. Using openrouter/${fallback}`,
		);
	});
});
