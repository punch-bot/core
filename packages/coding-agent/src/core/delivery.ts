import type { AgentMessage } from "@punch-bot/agent";
import type { TextContent } from "@punch-bot/ai";

export interface DeliveryEmbedAuthor {
	name: string;
	url?: string;
	icon_url?: string;
}

export interface DeliveryEmbedThumbnail {
	url?: string;
}

export interface DeliveryEmbedImage {
	url?: string;
}

export interface DeliveryEmbedFooter {
	text: string;
	icon_url?: string;
}

export interface DeliveryEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface DeliveryEmbed {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	author?: DeliveryEmbedAuthor;
	thumbnail?: DeliveryEmbedThumbnail;
	image?: DeliveryEmbedImage;
	footer?: DeliveryEmbedFooter;
	fields?: DeliveryEmbedField[];
	timestamp?: string;
}

export interface DeliveryQuestion {
	title?: string;
	description?: string;
	multi: boolean;
	style?: string;
	input: string[];
	options: string[];
}

export interface DeliveryAttachment {
	path: string;
	type?: "image" | "file";
	data?: string;
	mimeType?: string;
	name?: string;
}

export interface Delivery {
	text: string;
	embeds: DeliveryEmbed[];
	questions: DeliveryQuestion[];
	attachments: DeliveryAttachment[];
	errors: string[];
}

const EMBED_RE = /<embed\s*>([\s\S]*?)<\/embed>/gi;
const QUESTION_RE = /<question\b([^>]*)>([\s\S]*?)<\/question>/gi;
const QUESTION_OPTION_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const ATTACHMENT_RE =
	/<attachment\s+path="([^"]+)"\s*\/?>?\s*(?:<\/attachment\s*>)?|<attachment\s*>([\s\S]*?)<\/attachment>/gi;
const DISCORD_TAG_RE =
	/<(?:react|remember|forget|embed|question)\b[^>]*>[\s\S]*?<\/(?:react|remember|forget|embed|question)>/gi;
const DISCORD_SELF_CLOSING_RE = /<(?:react|forget)\b[^>]*\/?>/gi;

export function buildEmbedFromJson(j: unknown): DeliveryEmbed | null {
	if (!j || typeof j !== "object") return null;
	const input = j as Record<string, unknown>;
	const embed: DeliveryEmbed = {};
	if (typeof input.title === "string") embed.title = input.title.slice(0, 256);
	if (typeof input.description === "string") embed.description = input.description.slice(0, 4096);
	if (typeof input.url === "string") embed.url = input.url;
	if (typeof input.color === "number" && !Number.isNaN(input.color)) embed.color = input.color;
	const author = input.author as Record<string, unknown> | undefined;
	if (author && typeof author.name === "string") {
		embed.author = { name: author.name.slice(0, 256) };
		if (typeof author.url === "string") embed.author.url = author.url;
		if (typeof author.icon_url === "string") embed.author.icon_url = author.icon_url;
	}
	const thumbnail = input.thumbnail as Record<string, unknown> | undefined;
	if (thumbnail && typeof thumbnail.url === "string") embed.thumbnail = { url: thumbnail.url };
	const image = input.image as Record<string, unknown> | undefined;
	if (image && typeof image.url === "string") embed.image = { url: image.url };
	const footer = input.footer as Record<string, unknown> | undefined;
	if (footer && typeof footer.text === "string") {
		embed.footer = { text: footer.text.slice(0, 2048) };
		if (typeof footer.icon_url === "string") embed.footer.icon_url = footer.icon_url;
	}
	if (Array.isArray(input.fields)) {
		const fields: DeliveryEmbedField[] = [];
		for (const f of input.fields.slice(0, 25)) {
			const field = f as Record<string, unknown>;
			if (typeof field.name !== "string" || typeof field.value !== "string") continue;
			fields.push({
				name: field.name.slice(0, 256),
				value: field.value.slice(0, 1024),
				inline: field.inline === true,
			});
		}
		if (fields.length > 0) embed.fields = fields;
	}
	if (typeof input.timestamp === "string") {
		const ts = new Date(input.timestamp);
		if (!Number.isNaN(ts.getTime())) embed.timestamp = ts.toISOString();
	}
	return embed;
}

export function extractEmbeds(textIn: string): { clean: string; embeds: DeliveryEmbed[]; errors: string[] } {
	const embeds: DeliveryEmbed[] = [];
	const errors: string[] = [];
	const text = String(textIn || "");
	const clean = text
		.replace(EMBED_RE, (_match, body) => {
			try {
				const parsed = JSON.parse(String(body).trim());
				const embed = buildEmbedFromJson(parsed);
				if (embed) embeds.push(embed);
			} catch (err) {
				errors.push(`embed JSON error: ${(err as Error).message}`);
			}
			return "";
		})
		.trim();
	return { clean, embeds, errors };
}

export function parseQuestionAttrs(attrs: string): {
	title: string | undefined;
	description: string | undefined;
	multi: boolean;
	style: string | undefined;
	input: string[];
} {
	const titleMatch = /title="([^"]*)"/i.exec(attrs);
	const descriptionMatch = /description="([^"]*)"/i.exec(attrs);
	const styleMatch = /style="([^"]*)"/i.exec(attrs);
	const inputMatch = /input="([^"]*)"/i.exec(attrs);
	return {
		title: titleMatch ? titleMatch[1] : undefined,
		description: descriptionMatch ? descriptionMatch[1] : undefined,
		multi: /\bmulti\b/i.test(attrs.replace(/="[^"]*"/g, "")),
		style: styleMatch ? styleMatch[1].toLowerCase() : undefined,
		input: inputMatch
			? inputMatch[1]
					.split(";")
					.map((s) => s.trim())
					.filter(Boolean)
					.slice(0, 5)
			: [],
	};
}

export function parseQuestionOptions(body: string): string[] {
	const options: string[] = [];
	for (const line of String(body || "").split("\n")) {
		const m = QUESTION_OPTION_RE.exec(line);
		if (m) options.push(m[1].trim());
	}
	return options;
}

export function extractQuestions(textIn: string): { clean: string; questions: DeliveryQuestion[] } {
	const questions: DeliveryQuestion[] = [];
	const text = String(textIn || "");
	const clean = text
		.replace(QUESTION_RE, (_match, attrs, body) => {
			const q = parseQuestionAttrs(String(attrs));
			const options = parseQuestionOptions(String(body));
			if (options.length === 0 && q.input.length === 0) return "";
			questions.push({ ...q, options });
			return "";
		})
		.trim();
	return { clean, questions };
}

export function extractAttachments(textIn: string): { clean: string; attachments: string[] } {
	const paths: string[] = [];
	const text = String(textIn || "");
	const clean = text
		.replace(ATTACHMENT_RE, (_match, p1, p2) => {
			const p = (p1 || p2 || "").trim();
			if (p) paths.push(p);
			return "";
		})
		.trim();
	return { clean, attachments: paths };
}

export function stripDiscordMarkup(textIn: string): string {
	return String(textIn || "")
		.replace(DISCORD_TAG_RE, "")
		.replace(DISCORD_SELF_CLOSING_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function textFromMessage(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function imageAttachmentsFromMessage(message: AgentMessage): DeliveryAttachment[] {
	if (!("content" in message)) return [];
	const content = message.content;
	if (typeof content === "string") return [];
	return content
		.filter((part) => part.type === "image")
		.map((part, i) => ({
			path: `image-${i + 1}.${extFromMime(part.mimeType)}`,
			type: "image",
			data: part.data,
			mimeType: part.mimeType,
			name: `image-${i + 1}.${extFromMime(part.mimeType)}`,
		}));
}

function extFromMime(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "png";
	}
}

export function parseDelivery(text: string): Delivery {
	const errors: string[] = [];
	const embedsResult = extractEmbeds(text);
	errors.push(...embedsResult.errors);
	const questionsResult = extractQuestions(embedsResult.clean);
	const attachmentsResult = extractAttachments(questionsResult.clean);
	return {
		text: attachmentsResult.clean,
		embeds: embedsResult.embeds,
		questions: questionsResult.questions,
		attachments: attachmentsResult.attachments.map((path) => ({ path })),
		errors,
	};
}

export function deliveryFromMessage(message: AgentMessage): Delivery {
	const delivery = parseDelivery(textFromMessage(message));
	const images = imageAttachmentsFromMessage(message);
	if (images.length > 0) delivery.attachments = [...images, ...delivery.attachments];
	return delivery;
}
