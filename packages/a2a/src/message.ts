import type { Message, Part } from "@a2a-js/sdk";

export function extractTextFromMessage(message: Message | undefined): string {
	if (!message) return "";
	return message.parts
		.map((part) => extractTextFromPart(part))
		.filter((text) => text.length > 0)
		.join("\n")
		.trim();
}

export function extractTextFromPart(part: Part): string {
	const content = part.content;
	if (!content) return "";
	if (content.$case === "text") return content.value;
	if (content.$case === "raw") return content.value.toString("utf8");
	return "";
}

export function createTextMessage(
	text: string,
	options?: { role?: "user" | "agent"; taskId?: string; contextId?: string },
): Message {
	const role = options?.role === "agent" ? 2 : 1;
	return {
		role,
		messageId: crypto.randomUUID(),
		parts: [
			{
				content: { $case: "text", value: text },
				metadata: undefined,
				filename: "",
				mediaType: "text/plain",
			},
		],
		taskId: options?.taskId ?? "",
		contextId: options?.contextId ?? "",
		extensions: [],
		metadata: {},
		referenceTaskIds: [],
	};
}
