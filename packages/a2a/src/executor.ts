import { TaskState } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { extractTextFromMessage } from "./message.ts";

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
	private readonly runners = new Map<string, HarnessPromptRunner>();
	private readonly cancelledTasks = new Set<string>();
	private readonly runnerFactory: HarnessPromptRunnerFactory;

	constructor(runnerFactory: HarnessPromptRunnerFactory) {
		this.runnerFactory = runnerFactory;
	}

	cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
		this.cancelledTasks.add(taskId);
		for (const runner of this.runners.values()) {
			await runner.abort?.();
		}
		eventBus.publish(
			AgentEvent.statusUpdate({
				taskId,
				contextId: taskId,
				status: {
					state: TaskState.TASK_STATE_CANCELED,
					timestamp: new Date().toISOString(),
					message: undefined,
				},
				metadata: {},
			}),
		);
	};

	async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const taskId = requestContext.taskId;
		const contextId = requestContext.contextId;
		const userMessage = requestContext.userMessage;
		const existingTask = requestContext.task;
		const promptText = extractTextFromMessage(userMessage);

		const runner = this.runners.get(contextId) ?? this.runnerFactory(contextId);
		this.runners.set(contextId, runner);

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

			if (this.cancelledTasks.has(taskId)) {
				return;
			}

			const outcome = await runner.prompt(promptText);
			if (this.cancelledTasks.has(taskId)) {
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
							message: undefined,
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
		}
	}
}
