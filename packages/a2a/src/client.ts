import type { Message, SendMessageRequest, StreamResponse, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { Client, ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
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

async function createA2aClient(url: string): Promise<Client> {
	const factory = new ClientFactory({
		transports: [new JsonRpcTransportFactory()],
	});
	return factory.createFromUrl(url);
}

function extractArtifactTextFromTask(task: Task | undefined): string {
	if (!task) return "";
	const artifactText = task.artifacts
		.flatMap((artifact) => artifact.parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")))
		.filter(Boolean)
		.join("\n")
		.trim();
	return artifactText;
}

function extractErrorFromTask(task: Task | undefined): string | undefined {
	if (!task) return undefined;
	const state = task.status?.state;
	if (state === TaskState.TASK_STATE_FAILED) {
		const metadataError = task.metadata?.error;
		if (typeof metadataError === "string" && metadataError.length > 0) return metadataError;
		const statusText = extractTextFromMessage(task.status?.message);
		if (statusText) return statusText;
		return "Remote A2A task failed";
	}
	if (state === TaskState.TASK_STATE_REJECTED) {
		const statusText = extractTextFromMessage(task.status?.message);
		return statusText || "Remote A2A task rejected";
	}
	if (state === TaskState.TASK_STATE_CANCELED) {
		const statusText = extractTextFromMessage(task.status?.message);
		return statusText || "Remote A2A task canceled";
	}
	return undefined;
}

function extractTextFromTask(task: Task | undefined): string {
	if (!task) return "";
	const artifactText = extractArtifactTextFromTask(task);
	if (artifactText) return artifactText;
	return extractTextFromMessage(task.status?.message);
}

function extractArtifactTextFromStreamEvent(event: StreamResponse, artifactText: string): string {
	const payload = event.payload;
	if (!payload) return artifactText;
	switch (payload.$case) {
		case "task": {
			const taskArtifact = extractArtifactTextFromTask(payload.value);
			return taskArtifact || artifactText;
		}
		case "artifactUpdate": {
			const chunk =
				payload.value.artifact?.parts
					.map((part) => (part.content?.$case === "text" ? part.content.value : ""))
					.filter(Boolean)
					.join("\n") ?? "";
			if (!chunk) return artifactText;
			return payload.value.append ? `${artifactText}${chunk}` : chunk;
		}
		default:
			return artifactText;
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

function isFailedTerminalTaskState(state: TaskState | undefined): boolean {
	return (
		state === TaskState.TASK_STATE_FAILED ||
		state === TaskState.TASK_STATE_CANCELED ||
		state === TaskState.TASK_STATE_REJECTED
	);
}

function buildResultFromTask(task: Task): DelegateToA2aAgentResult {
	const state = task.status?.state;
	const error = extractErrorFromTask(task);
	const failed = error !== undefined || isFailedTerminalTaskState(state);
	return {
		text: extractTextFromTask(task),
		taskId: task.id,
		contextId: task.contextId,
		...(failed ? { failed: true, error: error ?? "Remote A2A task failed" } : {}),
	};
}

async function delegateToA2aAgentWithClient(
	client: Client,
	options: DelegateToA2aAgentOptions,
): Promise<DelegateToA2aAgentResult> {
	const response = await client.sendMessage(buildSendMessageRequest(options.task), { signal: options.signal });

	if ("parts" in response) {
		return { text: extractTextFromMessage(response as Message) };
	}

	return buildResultFromTask(response as Task);
}

async function delegateToA2aAgentStreamWithClient(
	client: Client,
	options: DelegateToA2aAgentOptions,
	onUpdate?: (text: string) => void,
): Promise<DelegateToA2aAgentResult> {
	const stream = client.sendMessageStream(buildStreamingSendMessageRequest(options.task), { signal: options.signal });

	let artifactText = "";
	let latestTask: Task | undefined;
	let taskId: string | undefined;
	let contextId: string | undefined;
	let failed = false;
	let error: string | undefined;
	for await (const event of stream) {
		artifactText = extractArtifactTextFromStreamEvent(event, artifactText);
		if (artifactText) onUpdate?.(artifactText);
		const payload = event.payload;
		if (payload?.$case === "task") {
			latestTask = payload.value;
			taskId = payload.value.id;
			contextId = payload.value.contextId;
			if (isFailedTerminalTaskState(payload.value.status?.state)) {
				failed = true;
				error = extractErrorFromTask(payload.value);
			}
			if (isTerminalTaskState(payload.value.status?.state)) {
				const terminalArtifact = extractArtifactTextFromTask(payload.value);
				if (terminalArtifact) artifactText = terminalArtifact;
			}
		}
		if (payload?.$case === "statusUpdate") {
			taskId = taskId ?? payload.value.taskId;
			contextId = contextId ?? payload.value.contextId;
			if (payload.value.status?.state === TaskState.TASK_STATE_COMPLETED) {
				latestTask = {
					id: taskId ?? payload.value.taskId,
					contextId: contextId ?? payload.value.contextId,
					status: payload.value.status,
					artifacts: latestTask?.artifacts ?? [],
					history: latestTask?.history ?? [],
					metadata: latestTask?.metadata ?? payload.value.metadata ?? {},
				};
			}
			if (isFailedTerminalTaskState(payload.value.status?.state)) {
				failed = true;
				error = extractErrorFromTask({
					id: taskId ?? payload.value.taskId,
					contextId: contextId ?? payload.value.contextId,
					status: payload.value.status,
					artifacts: latestTask?.artifacts ?? [],
					history: latestTask?.history ?? [],
					metadata: payload.value.metadata ?? latestTask?.metadata ?? {},
				});
			}
		}
	}

	const text = artifactText || extractTextFromTask(latestTask);
	if (text && !artifactText) onUpdate?.(text);

	return {
		text,
		taskId,
		contextId,
		...(failed ? { failed: true, error: error ?? "Remote A2A task failed" } : {}),
	};
}

export async function delegateToA2aAgent(options: DelegateToA2aAgentOptions): Promise<DelegateToA2aAgentResult> {
	const client = await createA2aClient(options.url);
	return delegateToA2aAgentWithClient(client, options);
}

export async function delegateToA2aAgentStream(
	options: DelegateToA2aAgentOptions,
	onUpdate?: (text: string) => void,
): Promise<DelegateToA2aAgentResult> {
	const client = await createA2aClient(options.url);
	return delegateToA2aAgentStreamWithClient(client, options, onUpdate);
}

export async function delegateToA2aAgentPreferStream(
	options: DelegateToA2aAgentOptions,
	onUpdate?: (text: string) => void,
): Promise<DelegateToA2aAgentResult> {
	const client = await createA2aClient(options.url);
	const card = await client.getAgentCard({ signal: options.signal });
	if (card.capabilities?.streaming) {
		return delegateToA2aAgentStreamWithClient(client, options, onUpdate);
	}
	const result = await delegateToA2aAgentWithClient(client, options);
	if (result.text) onUpdate?.(result.text);
	return result;
}
