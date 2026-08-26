import type { HarnessPromptRunner, HarnessPromptRunnerFactory } from "@punch-bot/a2a";
import type { AssistantMessage } from "@punch-bot/ai";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { findInitialModel } from "../../core/model-resolver.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

export interface CreateCodingAgentHarnessRunnerFactoryOptions {
	cwd?: string;
	agentDir?: string;
	maxContexts?: number;
}

const DEFAULT_MAX_CONTEXTS = 32;

function extractAssistantText(message: AssistantMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function findAssistantMessageAfterIndex(session: AgentSession, startIndex: number): AssistantMessage | undefined {
	for (let index = session.state.messages.length - 1; index >= startIndex; index--) {
		const message = session.state.messages[index];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

export async function createCodingAgentHarnessRunnerFactory(
	options: CreateCodingAgentHarnessRunnerFactoryOptions = {},
): Promise<HarnessPromptRunnerFactory> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const maxContexts = Math.max(1, options.maxContexts ?? DEFAULT_MAX_CONTEXTS);
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
	const thinkingLevel = initialModel.thinkingLevel;
	const contexts = new Map<string, { session: AgentSession; lastUsed: number }>();

	const evictContexts = (): void => {
		while (contexts.size > maxContexts) {
			let oldestContextId: string | undefined;
			let oldestUsed = Number.POSITIVE_INFINITY;
			for (const [contextId, context] of contexts) {
				if (context.lastUsed < oldestUsed) {
					oldestUsed = context.lastUsed;
					oldestContextId = contextId;
				}
			}
			if (!oldestContextId) return;
			const removed = contexts.get(oldestContextId);
			contexts.delete(oldestContextId);
			removed?.session.dispose();
		}
	};

	return (contextId: string): HarnessPromptRunner => ({
		async prompt(text, signal) {
			if (signal?.aborted) {
				return { message: "Task aborted" };
			}

			let context = contexts.get(contextId);
			if (!context) {
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRuntime,
					model,
					thinkingLevel,
					sessionManager: SessionManager.inMemory(cwd),
				});
				context = { session, lastUsed: Date.now() };
				contexts.set(contextId, context);
				evictContexts();
			}
			context.lastUsed = Date.now();

			const onAbort = () => {
				void context.session.abort();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const messageCountBefore = context.session.state.messages.length;
				await context.session.prompt(text, { expandPromptTemplates: false });
				const assistant = findAssistantMessageAfterIndex(context.session, messageCountBefore);
				if (!assistant) {
					return { message: "Agent completed without a response" };
				}
				if (assistant.stopReason === "error") {
					return { message: assistant.errorMessage ?? "Agent failed" };
				}
				if (assistant.stopReason === "aborted") {
					return { message: "Task aborted" };
				}
				return { text: extractAssistantText(assistant) };
			} catch (error) {
				return { message: error instanceof Error ? error.message : String(error) };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
		async abort() {
			const context = contexts.get(contextId);
			if (!context) return;
			await context.session.abort();
		},
		dispose() {
			const context = contexts.get(contextId);
			if (!context) return;
			contexts.delete(contextId);
			context.session.dispose();
		},
	});
}
