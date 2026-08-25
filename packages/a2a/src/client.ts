import type { Message, StreamResponse, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { extractTextFromMessage } from "./message.ts";

export interface DelegateToA2aAgentOptions {
	url: string;
	task: string;
	signal?: AbortSignal;
}

export interface DelegateToA2aAgentResult {
	text: string;
	taskId?: string;
	contextId?: string;
}

function extractTextFromTask(task: Task | undefined): string {
	if (!task) return "";
	const artifactText = task.artifacts
		.flatMap((artifact) => artifact.parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")))
		.filter(Boolean)
		.join("\n")
		.trim();
	if (artifactText) return artifactText;
	return extractTextFromMessage(task.status?.message);
}

function extractTextFromStreamEvent(event: StreamResponse): string {
	const payload = event.payload;
	if (!payload) return "";
	switch (payload.$case) {
		case "message":
			return extractTextFromMessage(payload.value);
		case "task":
			return extractTextFromTask(payload.value);
		case "statusUpdate":
			return extractTextFromMessage(payload.value.status?.message);
		case "artifactUpdate":
			return (
				payload.value.artifact?.parts
					.map((part) => (part.content?.$case === "text" ? part.content.value : ""))
					.filter(Boolean)
					.join("\n") ?? ""
			);
		default:
			return "";
	}
}

function isTerminalTaskState(state: TaskState | undefined): boolean {
	return (
		state === TaskState.TASK_STATE_COMPLETED ||
		state === TaskState.TASK_STATE_FAILED ||
		state === TaskState.TASK_STATE_CANCELED ||
		state === TaskState.TASK_STATE_REJECTED
	);
}

export async function delegateToA2aAgent(options: DelegateToA2aAgentOptions): Promise<DelegateToA2aAgentResult> {
	const factory = new ClientFactory({
		transports: [new JsonRpcTransportFactory()],
	});
	const client = await factory.createFromUrl(options.url);
	const response = await client.sendMessage(
		{
			message: {
				role: 1,
				messageId: crypto.randomUUID(),
				parts: [
					{
						content: { $case: "text", value: options.task },
						metadata: undefined,
						filename: "",
						mediaType: "text/plain",
					},
				],
				taskId: "",
				contextId: "",
				extensions: [],
				metadata: {},
				referenceTaskIds: [],
			},
			configuration: {
				acceptedOutputModes: ["text", "task-status"],
				returnImmediately: false,
				historyLength: 0,
				taskPushNotificationConfig: undefined,
			},
			metadata: {},
			tenant: "",
		},
		{ signal: options.signal },
	);

	if ("parts" in response) {
		return { text: extractTextFromMessage(response as Message) };
	}

	const task = response as Task;
	return {
		text: extractTextFromTask(task),
		taskId: task.id,
		contextId: task.contextId,
	};
}

export async function delegateToA2aAgentStream(
	options: DelegateToA2aAgentOptions,
	onUpdate?: (text: string) => void,
): Promise<DelegateToA2aAgentResult> {
	const factory = new ClientFactory({
		transports: [new JsonRpcTransportFactory()],
	});
	const client = await factory.createFromUrl(options.url);
	const stream = client.sendMessageStream(
		{
			message: {
				role: 1,
				messageId: crypto.randomUUID(),
				parts: [
					{
						content: { $case: "text", value: options.task },
						metadata: undefined,
						filename: "",
						mediaType: "text/plain",
					},
				],
				taskId: "",
				contextId: "",
				extensions: [],
				metadata: {},
				referenceTaskIds: [],
			},
			configuration: {
				acceptedOutputModes: ["text", "task-status"],
				returnImmediately: true,
				historyLength: 0,
				taskPushNotificationConfig: undefined,
			},
			metadata: {},
			tenant: "",
		},
		{ signal: options.signal },
	);

	let latestText = "";
	let taskId: string | undefined;
	let contextId: string | undefined;
	for await (const event of stream) {
		const chunk = extractTextFromStreamEvent(event);
		if (chunk) {
			latestText = chunk;
			onUpdate?.(chunk);
		}
		const payload = event.payload;
		if (payload?.$case === "task") {
			taskId = payload.value.id;
			contextId = payload.value.contextId;
			if (isTerminalTaskState(payload.value.status?.state)) {
				latestText = extractTextFromTask(payload.value) || latestText;
			}
		}
		if (payload?.$case === "statusUpdate" && isTerminalTaskState(payload.value.status?.state)) {
			latestText = extractTextFromMessage(payload.value.status?.message) || latestText;
		}
	}

	return { text: latestText, taskId, contextId };
}
