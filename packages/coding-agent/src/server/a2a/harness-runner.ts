import type { HarnessPromptRunner, HarnessPromptRunnerFactory } from "@punch-bot/a2a";
import { getOrThrow, InMemorySessionStorage, Session } from "@punch-bot/agent";
import { NodeExecutionEnv } from "@punch-bot/agent/node";
import { getAgentDir } from "../../config.ts";
import { findInitialModel } from "../../core/model-resolver.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createCodingAgentHarness } from "../create-harness.ts";

export interface CreateCodingAgentHarnessRunnerFactoryOptions {
	cwd?: string;
	agentDir?: string;
}

function extractAssistantText(message: { content?: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export async function createCodingAgentHarnessRunnerFactory(
	options: CreateCodingAgentHarnessRunnerFactoryOptions = {},
): Promise<HarnessPromptRunnerFactory> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const modelRuntime = await ModelRuntime.create({ authPath: undefined });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const initialModel = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
		modelRuntime,
	});
	if (!initialModel.model) {
		throw new Error("No model available for A2A server. Configure credentials and models first.");
	}
	const model = initialModel.model;
	const thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? "medium";
	const contexts = new Map<
		string,
		{ harness: Awaited<ReturnType<typeof createCodingAgentHarness>>["harness"]; env: NodeExecutionEnv }
	>();

	return (contextId: string): HarnessPromptRunner => ({
		async prompt(text, signal) {
			let context = contexts.get(contextId);
			if (!context) {
				const env = new NodeExecutionEnv({ cwd });
				const session = new Session(new InMemorySessionStorage({ id: `a2a-${contextId}`, createdAt: Date.now() }));
				const created = await createCodingAgentHarness({
					session,
					models: modelRuntime,
					model,
					thinkingLevel,
					env,
				});
				context = { harness: created.harness, env };
				contexts.set(contextId, context);
			}

			const abortController = new AbortController();
			const onAbort = () => {
				void context.harness.abort();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const result = getOrThrow(await context.harness.prompt(text));
				if (result.kind === "failed") {
					return { message: result.error.message };
				}
				if (result.kind === "aborted") {
					return { message: "Task aborted" };
				}
				if (result.kind === "suspended") {
					return { message: "Task suspended awaiting external input" };
				}
				return { text: extractAssistantText(result.finalMessage) };
			} catch (error) {
				return { message: error instanceof Error ? error.message : String(error) };
			} finally {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) abortController.abort();
			}
		},
		async abort() {
			const context = contexts.get(contextId);
			if (!context) return;
			await context.harness.abort();
		},
	});
}
