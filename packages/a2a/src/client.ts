import type { Message, SendMessageRequest, StreamResponse, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createTextMessage, extractTextFromMessage } from "./message.ts";

export interface DelegateToA2aAgentOptions {
	url: string;
	task: string;
	signal?: AbortSignal;
}

export interface DelegateToA2aAgentResult {
	text: string;
	taskId?: string;
	contextId?: string;
	failed?: boolean;
	error?: string;
}

function buildSendMessageRequest(task: string): SendMessageRequest {
	return {
		message: createTextMessage(task, { role: "user" }),
		configuration: {
			acceptedOutputModes: ["text"],
			returnImmediately: false,
			historyLength: 0,
			taskPushNotificationConfig: undefined,
		},
		metadata: {},
		tenant: "",
	};
}

function buildStreamingSendMessageRequest(task: string): SendMessageRequest {
	return {
		...buildSendMessageRequest(task),
		configuration: {
			acceptedOutputModes: ["text"],
			returnImmediately: true,
			historyLength: 0,
			taskPushNotificationConfig: undefined,
		},
	};
}

function extractErrorFromTask(task: Task | undefined): string | undefined {
	if (!task) return undefined;
	if (task.status?.state === TaskState.TASK_STATE_FAILED) {
		const metadataError = task.metadata?.error;
		if (typeof metadataError === "string" && metadataError.length > 0) return metadataError;
		const statusText = extractTextFromMessage(task.status?.message);
		if (statusText) return statusText;
		return "Remote A2A task failed";
	}
	return undefined;
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

function extractTextFromStreamEvent(event: StreamResponse, currentText: string): string {
	const payload = event.payload;
	if (!payload) return currentText;
	switch (payload.$case) {
		case "message":
			return extractTextFromMessage(payload.value) || currentText;
		case "task":
			return extractTextFromTask(payload.value) || currentText;
		case "statusUpdate":
			return extractTextFromMessage(payload.value.status?.message) || currentText;
		case "artifactUpdate": {
			const chunk =
				payload.value.artifact?.parts
					.map((part) => (part.content?.$case === "text" ? part.content.value : ""))
					.filter(Boolean)
					.join("\n") ?? "";
			if (!chunk) return currentText;
			return payload.value.append ? `${currentText}${chunk}` : chunk;
		}
		default:
			return currentText;
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

function buildResultFromTask(task: Task): DelegateToA2aAgentResult {
	const error = extractErrorFromTask(task);
	return {
		text: extractTextFromTask(task),
		taskId: task.id,
		contextId: task.contextId,
		...(error ? { failed: true, error } : {}),
	};
}

export async function delegateToA2aAgent(options: DelegateToA2aAgentOptions): Promise<DelegateToA2aAgentResult> {
	const factory = new ClientFactory({
		transports: [new JsonRpcTransportFactory()],
	});
	const client = await factory.createFromUrl(options.url);
	const response = await client.sendMessage(buildSendMessageRequest(options.task), { signal: options.signal });

	if ("parts" in response) {
		return { text: extractTextFromMessage(response as Message) };
	}

	return buildResultFromTask(response as Task);
}

export async function delegateToA2aAgentStream(
	options: DelegateToA2aAgentOptions,
	onUpdate?: (text: string) => void,
): Promise<DelegateToA2aAgentResult> {
	const factory = new ClientFactory({
		transports: [new JsonRpcTransportFactory()],
	});
	const client = await factory.createFromUrl(options.url);
	const stream = client.sendMessageStream(buildStreamingSendMessageRequest(options.task), { signal: options.signal });

	let latestText = "";
	let taskId: string | undefined;
	let contextId: string | undefined;
	let failed = false;
	let error: string | undefined;
	for await (const event of stream) {
		latestText = extractTextFromStreamEvent(event, latestText);
		if (latestText) onUpdate?.(latestText);
		const payload = event.payload;
		if (payload?.$case === "task") {
			taskId = payload.value.id;
			contextId = payload.value.contextId;
			if (payload.value.status?.state === TaskState.TASK_STATE_FAILED) {
				failed = true;
				error = extractErrorFromTask(payload.value);
			}
			if (isTerminalTaskState(payload.value.status?.state)) {
				latestText = extractTextFromTask(payload.value) || latestText;
			}
		}
		if (payload?.$case === "statusUpdate") {
			if (payload.value.status?.state === TaskState.TASK_STATE_FAILED) {
				failed = true;
				error = extractTextFromMessage(payload.value.status?.message) || error;
			}
			if (isTerminalTaskState(payload.value.status?.state)) {
				latestText = extractTextFromMessage(payload.value.status?.message) || latestText;
			}
		}
	}

	return {
		text: latestText,
		taskId,
		contextId,
		...(failed ? { failed: true, error: error ?? "Remote A2A task failed" } : {}),
	};
}
