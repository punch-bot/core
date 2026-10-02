/**
 * Raw provider event viewer.
 *
 * Usage: /debug-provider [on|off]
 * With no argument, the command toggles capture. Captured events are persisted
 * as custom entries.
 */

import type { ExtensionAPI } from "@punch-bot/cli";

const ENTRY_TYPE = "debug-provider-events";
const STATUS_KEY = "debug-provider";

interface ProviderDebugEntry {
	provider: string;
	api: string;
	model: string;
	events: unknown[];
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let activeEvents: unknown[] | undefined;
	let completedEntry: ProviderDebugEntry | undefined;

	pi.registerCommand("debug-provider", {
		description: "Toggle capture of raw provider stream events",
		handler: async (args, ctx) => {
			const requestedState = args.trim().toLowerCase();
			if (requestedState !== "" && requestedState !== "on" && requestedState !== "off") {
				ctx.ui.notify("Usage: /debug-provider [on|off]", "warning");
				return;
			}

			enabled = requestedState === "" ? !enabled : requestedState === "on";
			if (!enabled) {
				activeEvents = undefined;
				completedEntry = undefined;
			}
			ctx.ui.setStatus(STATUS_KEY, enabled ? "provider debug" : undefined);
			ctx.ui.notify(`Provider event capture ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("turn_start", () => {
		activeEvents = enabled ? [] : undefined;
	});

	pi.on("provider_stream_event", (event) => {
		activeEvents?.push(structuredClone(event.data));
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !activeEvents) return;
		completedEntry = {
			provider: event.message.provider,
			api: event.message.api,
			model: event.message.model,
			events: activeEvents,
		};
		activeEvents = undefined;
	});

	pi.on("turn_end", () => {
		if (!completedEntry) return;
		pi.appendEntry<ProviderDebugEntry>(ENTRY_TYPE, completedEntry);
		completedEntry = undefined;
	});
}
