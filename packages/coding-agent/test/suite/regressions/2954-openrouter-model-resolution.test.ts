import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { resolveCliModel, resolveModelScopeFromModels } from "../../../src/core/model-resolver.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regressions #2954 and #3042: OpenRouter base models and variants", () => {
	let harness: Harness;
	const cleanups: Array<() => void | Promise<void>> = [];

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		harness.cleanup();
	});

	async function catalog(ids: string[], provider = "openrouter") {
		const faux = fauxProvider({ provider, models: ids.map((id) => ({ id, reasoning: true })) });
		harness.session.modelRuntime.registerNativeProvider(faux.provider);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		return faux;
	}

	function resolve(cliModel: string, cliProvider?: string) {
		return resolveCliModel({ cliModel, cliProvider, modelRuntime: harness.session.modelRuntime });
	}

	const runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = {
			cwd,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		};
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: [],
		};
	};

	it("selects exactly the requested base or variant when both exist", async () => {
		const ids = ["fixture/model", "fixture/model:free", "fixture/model:batch", "fixture/model:future-service"];
		const faux = await catalog(ids);
		for (const id of ids) {
			for (const result of [
				resolve(id, "openrouter"),
				resolve(`openrouter/${id}`),
				resolve(`openrouter/${id}`, "openrouter"),
			]) {
				expect(result.model).toBe(faux.getModel(id));
				expect(result.error).toBeUndefined();
				expect(result.warning).toBeUndefined();
				expect(result.thinkingLevel).toBeUndefined();
			}
		}
	});

	it("matches a partial id to the base model instead of its variants, with a warning", async () => {
		const faux = await catalog(["fixture/model", "fixture/model:free", "fixture/model:batch"]);
		for (const [cliModel, cliProvider] of [["model", "openrouter"], ["openrouter/model"]]) {
			expect(resolve(cliModel, cliProvider)).toMatchObject({
				model: faux.getModel("fixture/model"),
				warning: `No exact match for "${cliModel}". Using openrouter/fixture/model.`,
			});
		}
		expect(resolve("model:high", "openrouter")).toMatchObject({
			model: { id: "fixture/model" },
			thinkingLevel: "high",
		});
		const scope = resolveModelScopeFromModels(["openrouter/model"], faux.models);
		expect(scope.scopedModels.map((scoped) => scoped.model.id)).toEqual(["fixture/model"]);
		expect(scope.diagnostics).toMatchObject([{ code: "partial-match" }]);
	});

	it("names the variant it picks when only variants match", async () => {
		await catalog(["fixture/model:free", "fixture/model:batch"]);
		const result = resolve("fixture/model", "openrouter");
		expect(result.model?.id).toBe("fixture/model:free");
		expect(result.warning).toBe('No exact match for "fixture/model". Using openrouter/fixture/model:free.');
	});

	it("sends an unknown suffix on a catalog id with the catalog model's metadata", async () => {
		const faux = await catalog(["fixture/model"]);
		const base = faux.getModel("fixture/model")!;
		for (const result of [resolve("openrouter/fixture/model:nitro"), resolve("fixture/model:nitro", "openrouter")]) {
			expect(result.model).toEqual({ ...base, id: "fixture/model:nitro", name: `${base.name} (nitro)` });
			expect(result.warning).toContain("Using custom model id");
		}
		expect(resolve("openrouter/fixture/model:nitro:high")).toMatchObject({
			model: { id: "fixture/model:nitro" },
			thinkingLevel: "high",
		});
	});

	it("preserves raw IDs starting with the explicit provider name", async () => {
		await catalog(["openrouter/fusion", "fusion", "openrouter/fusion:free"]);
		expect(resolve("openrouter/fusion", "openrouter").model?.id).toBe("openrouter/fusion");
		expect(resolve("openrouter/fusion:free:high", "openrouter")).toMatchObject({
			model: { id: "openrouter/fusion:free" },
			thinkingLevel: "high",
		});
		expect(resolve("openrouter/openrouter/fusion").model?.id).toBe("openrouter/fusion");
	});

	it("preserves literal colon IDs before parsing one thinking suffix", async () => {
		await catalog(["fixture/model", "fixture/model:free", "fixture/model:high", "fixture/model:free:high"]);
		expect(resolve("openrouter/fixture/model:high").thinkingLevel).toBeUndefined();
		expect(resolve("openrouter/fixture/model:high").model?.id).toBe("fixture/model:high");
		expect(resolve("openrouter/fixture/model:free:high").model?.id).toBe("fixture/model:free:high");
		expect(resolve("openrouter/fixture/model:free:high:low")).toMatchObject({
			model: { id: "fixture/model:free:high" },
			thinkingLevel: "low",
		});
	});

	it("preserves literal brackets and colon suffixes in automation scopes", async () => {
		const faux = await catalog(["fixture/model[1m]", "fixture/model[1m]:high"]);
		const scope = resolveModelScopeFromModels(["openrouter/fixture/model[1m]:high"], faux.models);
		expect(scope.scopedModels).toMatchObject([{ model: { id: "fixture/model[1m]:high" }, thinkingLevel: undefined }]);
		expect(scope.diagnostics).toEqual([]);
	});

	it("uses an explicit models.json definition's own capabilities and pricing", async () => {
		await catalog(["fixture/model:free"]);
		const defined = await createHarness({
			modelsJson: {
				providers: {
					openrouter: {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						apiKey: "faux-key",
						models: [
							{
								id: "fixture/model",
								name: "Explicit base",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
								contextWindow: 64000,
								maxTokens: 4000,
							},
						],
					},
				},
			},
		});
		cleanups.push(defined.cleanup);
		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "fixture/model",
			modelRuntime: defined.session.modelRuntime,
		});
		expect(result.model).toMatchObject({
			id: "fixture/model",
			name: "Explicit base",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 8 },
			contextWindow: 64000,
			maxTokens: 4000,
		});
	});

	it("restores saved variants exactly, including routing suffixes and model-only sessions", async () => {
		await catalog(["fixture/model", "fixture/model:free"]);
		for (const id of ["fixture/model:free", "fixture/model:nitro"]) {
			const manager = SessionManager.inMemory(harness.tempDir);
			manager.appendModelChange("openrouter", id);
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: createTestResourceLoader(),
				sessionManager: manager,
			});
			cleanups.push(() => session.dispose());
			expect(session.model?.id).toBe(id);
			expect(modelFallbackMessage).toBeUndefined();
		}
	});

	it("falls back to the default and says why when a saved model is gone", async () => {
		const faux = await catalog(["fixture/model", "fixture/model:free"]);
		harness.settingsManager.setDefaultModelAndProvider("openrouter", "fixture/model");
		const runtime = await createAgentSessionRuntime(runtimeFactory, {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		cleanups.push(() => runtime.dispose());
		const saved = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		saved.appendModelChange("openrouter", "fixture/model:free");
		saved.appendMessage({ ...fauxAssistantMessage("saved"), provider: "openrouter", model: "fixture/model:free" });
		await runtime.switchSession(saved.getSessionFile()!);
		expect(runtime.session.model?.id).toBe("fixture/model:free");

		const missing = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		missing.appendModelChange("openrouter", "fixture/missing");
		missing.appendMessage({ ...fauxAssistantMessage("missing"), provider: "openrouter", model: "fixture/missing" });
		await runtime.switchSession(missing.getSessionFile()!);
		expect(runtime.session.model?.id).toBe("fixture/model");
		expect(runtime.modelFallbackMessage).toBe(
			"Could not restore model openrouter/fixture/missing. Using openrouter/fixture/model",
		);
		faux.setResponses([fauxAssistantMessage("still usable")]);
		await runtime.session.prompt("after fallback");
		expect(runtime.session.getLastAssistantText()).toBe("still usable");
	});
});
