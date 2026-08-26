import { TaskState } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { createTextMessage, extractTextFromMessage } from "./message.ts";

export interface HarnessPromptResult {
	text: string;
}

export interface HarnessPromptError {
	message: string;
}

export type HarnessPromptOutcome = HarnessPromptResult | HarnessPromptError;

export function isHarnessPromptError(outcome: HarnessPromptOutcome): outcome is HarnessPromptError {
	return "message" in outcome;
}

export interface HarnessPromptRunner {
	prompt(text: string, signal?: AbortSignal): Promise<HarnessPromptOutcome>;
	abort?(): Promise<void>;
}

export type HarnessPromptRunnerFactory = (contextId: string) => HarnessPromptRunner;

export class HarnessAgentExecutor implements AgentExecutor {
	private readonly taskContexts = new Map<string, string>();
	private readonly cancelledTasks = new Set<string>();
	private readonly taskAbortControllers = new Map<string, AbortController>();
	private readonly contextChains = new Map<string, Promise<unknown>>();
	private readonly runnerFactory: HarnessPromptRunnerFactory;

	constructor(runnerFactory: HarnessPromptRunnerFactory) {
		this.runnerFactory = runnerFactory;
	}

	cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
		this.cancelledTasks.add(taskId);
		this.taskAbortControllers.get(taskId)?.abort();
		const contextId = this.taskContexts.get(taskId);
		eventBus.publish(
			AgentEvent.statusUpdate({
				taskId,
				contextId: contextId ?? taskId,
				status: {
					state: TaskState.TASK_STATE_CANCELED,
					timestamp: new Date().toISOString(),
					message: undefined,
				},
				metadata: {},
			}),
		);
	};

	private runInContext<T>(contextId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.contextChains.get(contextId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(() => fn());
		this.contextChains.set(contextId, current);
		return current.finally(() => {
			if (this.contextChains.get(contextId) === current) {
				this.contextChains.delete(contextId);
			}
		});
	}

	async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const taskId = requestContext.taskId;
		const contextId = requestContext.contextId;
		const userMessage = requestContext.userMessage;
		const existingTask = requestContext.task;
		const promptText = extractTextFromMessage(userMessage);

		await this.runInContext(contextId, async () => {
			const abortController = new AbortController();
			this.taskAbortControllers.set(taskId, abortController);

			let runner: HarnessPromptRunner;
			try {
				runner = this.runnerFactory(contextId);
				this.taskContexts.set(taskId, contextId);
			} catch (error) {
				this.taskAbortControllers.delete(taskId);
				throw error;
			}

			try {
				const taskSnapshot = existingTask ?? {
					id: taskId,
					contextId,
					status: {
						state: TaskState.TASK_STATE_SUBMITTED,
						timestamp: new Date().toISOString(),
						message: undefined,
					},
					artifacts: [],
					history: [userMessage],
					metadata: userMessage.metadata,
				};
				eventBus.publish(AgentEvent.task(taskSnapshot));

				eventBus.publish(
					AgentEvent.statusUpdate({
						taskId,
						contextId,
						status: {
							state: TaskState.TASK_STATE_WORKING,
							timestamp: new Date().toISOString(),
							message: undefined,
						},
						metadata: {},
					}),
				);

				if (this.cancelledTasks.has(taskId) || abortController.signal.aborted) {
					return;
				}

				const outcome = await runner.prompt(promptText, abortController.signal);
				if (this.cancelledTasks.has(taskId) || abortController.signal.aborted) {
					return;
				}

				if (isHarnessPromptError(outcome)) {
					eventBus.publish(
						AgentEvent.statusUpdate({
							taskId,
							contextId,
							status: {
								state: TaskState.TASK_STATE_FAILED,
								timestamp: new Date().toISOString(),
								message: createTextMessage(outcome.message, { role: "agent", taskId, contextId }),
							},
							metadata: { error: outcome.message },
						}),
					);
					return;
				}

				eventBus.publish(
					AgentEvent.artifactUpdate({
						taskId,
						contextId,
						artifact: {
							artifactId: crypto.randomUUID(),
							name: "Result",
							description: "Agent response",
							parts: [
								{
									content: { $case: "text", value: outcome.text },
									metadata: undefined,
									filename: "",
									mediaType: "text/plain",
								},
							],
							metadata: undefined,
							extensions: [],
						},
						lastChunk: true,
						append: false,
						metadata: undefined,
					}),
				);

				eventBus.publish(
					AgentEvent.statusUpdate({
						taskId,
						contextId,
						status: {
							state: TaskState.TASK_STATE_COMPLETED,
							timestamp: new Date().toISOString(),
							message: undefined,
						},
						metadata: undefined,
					}),
				);
			} finally {
				this.cancelledTasks.delete(taskId);
				this.taskAbortControllers.delete(taskId);
				this.taskContexts.delete(taskId);
			}
		});
	}
}
