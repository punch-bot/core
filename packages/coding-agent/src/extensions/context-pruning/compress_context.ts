import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@punch-bot/agent";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { PruningRecord, PruningState } from "./context-pruning-state.ts";
import {
	activeBlocks,
	activeMessageIds,
	blockPreview,
	createBlock,
	deactivateBlock,
	emptyState,
	messageRecords,
	normalizeState,
	recompressBlock,
	STATE_TYPE,
	searchBlocks,
} from "./context-pruning-state.ts";

const MAX_MEMORY_CHARS = 12_000;

function memoryFilePath(ctx: ExtensionContext): string {
	return process.env.PI_MEMORY_FILE || path.join(ctx.cwd, ".punch-memory.md");
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function loadState(ctx: ExtensionContext): PruningState {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type === "custom" && entry.customType === STATE_TYPE) return normalizeState(entry.data);
	}
	return emptyState();
}

function saveState(pi: ExtensionAPI, _ctx: ExtensionContext, state: PruningState) {
	pi.appendEntry(STATE_TYPE, state);
}

function records(ctx: ExtensionContext): PruningRecord[] {
	return messageRecords(ctx.sessionManager.buildContextEntries());
}

function messageSignature(message: { role?: string; content?: unknown; toolCallId?: string; toolName?: string }) {
	return JSON.stringify({
		role: message?.role,
		content: message?.content,
		toolCallId: message?.toolCallId,
		toolName: message?.toolName,
	});
}

function matchEntryIds(ctx: ExtensionContext, messages: Array<{ role?: string; content?: unknown }>) {
	const idsBySignature = new Map<string, string[]>();
	for (const record of records(ctx)) {
		const signature = messageSignature(record.message);
		const ids = idsBySignature.get(signature) ?? [];
		ids.push(record.id);
		idsBySignature.set(signature, ids);
	}
	return messages.map((message) => idsBySignature.get(messageSignature(message))?.shift());
}

function addMessageId(message: AgentMessage, id: string): AgentMessage {
	if (message.role !== "user") return message;
	const marker = `\n\n<punch-message-id>${id}</punch-message-id>`;
	if (!("content" in message)) return message;
	if (typeof message.content === "string") return { ...message, content: `${message.content}${marker}` };
	if (Array.isArray(message.content)) {
		return { ...message, content: [...message.content, { type: "text", text: marker }] };
	}
	return message;
}

function compressedSummary(block: PruningState["blocks"][number]): AgentMessage {
	const topic = block.topic ? `: ${block.topic}` : "";
	return {
		role: "custom",
		customType: STATE_TYPE,
		content: `<compressed-context id="${block.id}">${topic}\n${block.summary}\n</compressed-context>`,
		display: false,
		timestamp: Date.now(),
	};
}

export default function contextPruningExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		const threshold = Number(process.env.PI_CONTEXT_PRUNING_THRESHOLD || 0);
		const usage = ctx.getContextUsage();
		const nudge =
			threshold > 0 && usage?.percent != null && usage.percent >= threshold
				? `\n\n## Context pruning now\nUsage ${Math.round(usage.percent)}% — compress stale complete ranges with compress_context before continuing. Keep current work and recent turns raw.`
				: "";
		if (!nudge) return;
		return {
			systemPrompt: `${event.systemPrompt}${nudge}`,
		};
	});

	pi.on("context", (event, ctx) => {
		const state = loadState(ctx);
		const blocks = activeBlocks(state);
		const ids = matchEntryIds(ctx, event.messages);
		const hidden = activeMessageIds(state);
		if ([...hidden].some((id) => !ids.includes(id))) {
			return {
				messages: event.messages.map((message, index) =>
					ids[index] ? addMessageId(message, ids[index]!) : message,
				),
			};
		}

		const byAnchor = new Map(blocks.map((block) => [block.anchorId, block]));
		const messages: typeof event.messages = [];
		for (let index = 0; index < event.messages.length; index += 1) {
			const id = ids[index];
			const block = id ? byAnchor.get(id) : undefined;
			if (block) messages.push(compressedSummary(block));
			if (id && hidden.has(id)) continue;
			messages.push(id ? addMessageId(event.messages[index], id) : event.messages[index]);
		}
		return { messages };
	});

	pi.registerTool({
		name: "compress_context",
		label: "Compress context range",
		promptSnippet:
			"Compress stale complete conversation ranges when context is crowded; use visible punch-message-id values.",
		promptGuidelines: [
			"Before compression, save durable project facts to the project memory file.",
			"Only compress complete stale user-turn ranges. Keep active task discussion and recent turns visible.",
			"Supply a self-contained summary. The original session remains retrievable with decompress_context.",
			"Do not compress ranges that contain compression or task tools (compress_context, decompress_context, recompress_context, context_status, search_context, task). Those turns are protected.",
		],
		description:
			"Replace a stale range of complete conversation turns with your summary for future model calls. Boundaries must be visible user-message IDs. Original session entries remain intact and can be restored with decompress_context.",
		executionMode: "sequential",
		parameters: Type.Object({
			startId: Type.String({ description: "Earlier visible user punch-message-id" }),
			endId: Type.String({ description: "Later visible user punch-message-id" }),
			summary: Type.String({ description: "Self-contained summary replacing the range" }),
			topic: Type.Optional(Type.String({ description: "Short range label" })),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const state = createBlock(loadState(ctx), records(ctx), args);
			saveState(pi, ctx, state);
			const block = state.blocks.at(-1)!;
			return textResult(
				`Compressed ${block.id}: ${block.messageIds.length} messages, ${block.sourceCharacters} source characters. Use decompress_context with ${block.id} to restore it.`,
			);
		},
	});

	pi.registerTool({
		name: "recompress_context",
		label: "Recompress into denser summary",
		promptSnippet:
			"Condense multiple deactivated blocks into a single denser tier-2 block when context is tight. Parent blocks must be deactivated first.",
		promptGuidelines: [
			"Deactivate the source blocks with decompress_context before recompressing them.",
			"The new summary should be more concise than the individual block summaries combined.",
		],
		description:
			"Combine 2+ deactivated (restored) blocks into a single tier-2 compressed block with a condensed summary. Frees the anchor slot and reduces context overhead.",
		executionMode: "sequential",
		parameters: Type.Object({
			blockIds: Type.Array(Type.String(), {
				description: 'IDs of deactivated blocks to condense, e.g. ["b1", "b2"]',
			}),
			summary: Type.String({ description: "Condensed summary replacing all parent summaries" }),
			topic: Type.Optional(Type.String({ description: "Short label" })),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const state = recompressBlock(loadState(ctx), args.blockIds, args);
			saveState(pi, ctx, state);
			const block = state.blocks.at(-1)!;
			return textResult(
				`Recompressed ${args.blockIds.join(", ")} into ${block.id} [T2]: ${block.messageIds.length} messages, ${block.sourceCharacters} source characters.`,
			);
		},
	});

	pi.registerTool({
		name: "decompress_context",
		label: "Restore context range",
		description:
			"Restore a previously compressed block for future model calls. Returns a bounded preview immediately; original session entries are never deleted.",
		executionMode: "sequential",
		parameters: Type.Object({ blockId: Type.String({ description: "Active block ID, such as b1" }) }),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const block = activeBlocks(state).find((candidate) => candidate.id === args.blockId);
			if (!block) throw new Error(`active block ${args.blockId} not found`);
			const next = deactivateBlock(state, args.blockId);
			saveState(pi, ctx, next);
			return textResult(`Restored ${args.blockId}. Preview:\n${blockPreview(records(ctx), block)}`);
		},
	});

	pi.registerTool({
		name: "context_status",
		label: "Context pruning status",
		description: "Show active compressed ranges and context usage.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _args, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const blocks = activeBlocks(state);
			const usage = ctx.getContextUsage();
			const lines = blocks.map(
				(block) =>
					`${block.id} [T${block.tier || 1}]: ${block.messageIds.length} messages, ${block.sourceCharacters} source chars${block.topic ? `, ${block.topic}` : ""}${block.parentBlockIds ? `, from ${block.parentBlockIds.join(", ")}` : ""}`,
			);
			return textResult(
				[
					`Active compressed blocks: ${blocks.length}.`,
					usage?.percent == null ? "Context usage unavailable." : `Context usage: ${Math.round(usage.percent)}%.`,
					lines.join("\n") || "No ranges compressed.",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "search_context",
		label: "Search compressed context",
		description: "Search active compressed summaries before restoring a block.",
		parameters: Type.Object({ query: Type.String({ description: "Words to search" }) }),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const results = searchBlocks(loadState(ctx), args.query);
			if (!results.length) return textResult("No matching compressed blocks.");
			return textResult(
				results
					.map(
						({ block }) =>
							`${block.id}${block.topic ? ` (${block.topic})` : ""}: ${block.summary.slice(0, 1_000)}`,
					)
					.join("\n\n"),
			);
		},
	});

	pi.registerTool({
		name: "update_memory",
		label: "Update project memory",
		description:
			"Add or update a section in the project memory file. Sections are delimited by ## headers. Replaces existing content for the same section name.",
		promptSnippet:
			"Save durable project context to the project memory file before compression or when you learn something worth keeping across sessions.",
		promptGuidelines: [
			"Keep entries concise and scoped to what matters long-term.",
			"Use existing section names to update them or new names to create sections.",
			"The file survives session resets and compactions — write decisions, conventions, gotchas, and preferences.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			section: Type.String({ description: "Section name without ## prefix, e.g. Guidelines or Open work" }),
			content: Type.String({ description: "Section body as markdown" }),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const filePath = memoryFilePath(ctx);
			let existing = "";
			try {
				existing = await readFile(filePath, "utf8");
			} catch {
				// memory file may not exist yet
			}
			const content = args.content.trim().replace(/^(## )/gm, "\\$1");
			const header = `## ${args.section}`;
			const sectionPattern = new RegExp(
				`(?:^|\n)${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n.*?(?=\n## |\n*$)`,
				"ds",
			);
			const newSection = `\n${header}\n${content}`;
			let updated: string;
			if (sectionPattern.test(existing)) {
				updated = existing.replace(sectionPattern, newSection);
			} else {
				updated = existing.trimEnd() + newSection;
			}
			if (updated.length > MAX_MEMORY_CHARS) {
				return textResult(
					`Update skipped: memory would be ${updated.length} characters (max ${MAX_MEMORY_CHARS}). Shorten the content or remove old sections.`,
				);
			}
			await writeFile(filePath, updated, "utf8");
			return textResult(`Memory section "${args.section}" updated.`);
		},
	});
}
