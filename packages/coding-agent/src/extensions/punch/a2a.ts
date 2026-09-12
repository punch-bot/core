import {
	type A2aPeerRecord,
	defaultA2aDiscoveryDir,
	delegateToA2aAgentPreferStream,
	LocalA2aDiscovery,
} from "@punch-bot/a2a";
import type { AgentMessage } from "@punch-bot/agent";
import { StringEnum } from "@punch-bot/ai";
import { Type } from "typebox";

import type { ExtensionAPI } from "../../core/extensions/types.ts";

export interface InstallPunchA2aOptions {
	env?: NodeJS.ProcessEnv;
	discovery?: LocalA2aDiscovery;
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return value === "1" || normalized === "true" || normalized === "yes";
}

function isDisabled(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return value === "0" || normalized === "false" || normalized === "no";
}

export function isPunchA2aEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (isDisabled(env.PUNCH_A2A)) return false;
	if (isTruthy(env.PUNCH_A2A)) return true;
	return Boolean(env.SANDBOX_NAME?.trim());
}

export function punchSandboxName(env: NodeJS.ProcessEnv = process.env): string {
	const named = env.SANDBOX_NAME || env.PI_SERVER_USERNAME || env.OPENCODE_SERVER_USERNAME;
	if (named?.trim()) return named.trim();
	return `pi-${process.pid}`;
}

export function formatA2aPeers(peers: readonly A2aPeerRecord[]): string {
	if (peers.length === 0) return "No other punch sandboxes discovered on this machine.";
	return peers
		.map((peer) => {
			const cwd = peer.cwd ? ` cwd=${peer.cwd}` : "";
			return `${peer.name} ${peer.url}${cwd}`;
		})
		.join("\n");
}

export function installA2a(pi: ExtensionAPI, options: InstallPunchA2aOptions = {}): void {
	const env = options.env ?? process.env;
	if (!isPunchA2aEnabled(env)) return;

	const discovery = options.discovery ?? new LocalA2aDiscovery({ dir: defaultA2aDiscoveryDir(env) });
	const excludePid = process.pid;

	pi.on("context", (event) => {
		const peers = discovery.list({ excludePid });
		if (peers.length === 0) return;
		const message: AgentMessage = {
			role: "custom",
			customType: "punch-a2a-peers",
			content: `Local punch sandboxes reachable over A2A:\n${formatA2aPeers(peers)}`,
			display: false,
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, message] };
	});

	pi.registerTool({
		name: "a2a",
		label: "Punch A2A",
		description:
			"Discover and message other punch sandboxes on this machine over A2A. Use list to see peers, send to delegate a task by sandbox name.",
		promptSnippet: "Talk to other local punch sandboxes over A2A",
		promptGuidelines: [
			"Use a2a with action=list to see punch sandboxes on this machine.",
			"Use a2a with action=send to ask a named local sandbox to do work.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "send"] as const),
			name: Type.Optional(Type.String({ description: "Sandbox name, for send" })),
			task: Type.Optional(Type.String({ description: "Work to send to the peer sandbox" })),
		}),
		async execute(_toolCallId, args, signal, onUpdate) {
			if (args.action === "list") {
				const peers = discovery.list({ excludePid });
				return { content: [{ type: "text", text: formatA2aPeers(peers) }], details: { peers } };
			}
			if (!args.name?.trim()) throw new Error("name is required to send");
			if (!args.task?.trim()) throw new Error("task is required to send");
			const peer = discovery.find(args.name, { excludePid });
			if (!peer) throw new Error(`No local punch sandbox named "${args.name.trim()}"`);
			const result = await delegateToA2aAgentPreferStream({ url: peer.url, task: args.task, signal }, (text) => {
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { peer },
				});
			});
			if (result.failed) {
				return {
					content: [{ type: "text", text: result.error ?? "A2A send failed" }],
					details: { peer, failed: true, error: result.error },
				};
			}
			return {
				content: [{ type: "text", text: result.text || "(empty response)" }],
				details: { peer },
			};
		},
	});
}
