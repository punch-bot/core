import { execFileSync } from "node:child_process";

import { StringEnum } from "@punch-bot/ai";
import { Type } from "typebox";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { getAuthHeader, isAuthConfigured } from "./auth.ts";
import { startScheduler } from "./routines.ts";
import { startPunchServer } from "./server.ts";

const PORT = Number(process.env.PI_BOT_PORT) || 4098;
const BOT_URL = process.env.PUNCH_BOT_URL || `http://localhost:${PORT}`;

function authHeader(): string {
	const envUser = process.env.PI_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || "opencode";
	const envPass = process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || "";
	if (envPass) return `Basic ${Buffer.from(`${envUser}:${envPass}`).toString("base64")}`;
	return getAuthHeader() ?? `Basic ${Buffer.from(`${envUser}:`).toString("base64")}`;
}

function safeBotUrl(): string | null {
	const url = BOT_URL;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:") return url;
		if (
			parsed.protocol === "http:" &&
			(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1")
		)
			return url;
	} catch {}
	return null;
}

async function botFetch(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
	const url = safeBotUrl();
	if (!url) throw new Error("PUNCH_BOT_URL must use https or a localhost http endpoint");
	const response = await fetch(`${url}${path}`, {
		...init,
		headers: { "content-type": "application/json", authorization: authHeader(), ...(init.headers ?? {}) },
	});
	const text = await response.text();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	if (!response.ok) throw new Error((data as { error?: string }).error || `${response.status} ${text}`);
	return (data ?? {}) as Record<string, unknown>;
}

function git(workspace: string, args: string[]): string {
	return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
}

function sandboxActor(): string {
	return process.env.PI_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || "opencode";
}

export default function punchExtension(pi: ExtensionAPI): void {
	startScheduler(async (routine) => {
		switch (routine.type) {
			case "message":
				pi.sendUserMessage(routine.payload);
				break;
			case "heartbeat":
				pi.sendUserMessage(`heartbeat: ${routine.payload}`);
				break;
			case "llm":
				pi.sendUserMessage(routine.payload);
				break;
		}
	});
	if (!isAuthConfigured()) {
		console.warn("punch server disabled: no auth credentials configured");
	}
	startPunchServer();

	pi.registerTool({
		name: "collab",
		label: "Punch collaboration",
		description:
			"Propose, fetch, and review a two-agent Git collaboration. Canonical main auto-merges only after both agents approve the same SHA.",
		promptSnippet: "Use collab for shared cross-sandbox code review",
		promptGuidelines: [
			"Before approving, fetch exact proposed SHA, inspect diff, and run relevant tests.",
			"Any change needs a new proposal and a fresh review.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "list", "status", "propose", "review"] as const),
			id: Type.Optional(Type.String({ description: "Collaboration ID" })),
			reviewer: Type.Optional(Type.String({ description: "Other registered sandbox name, for start" })),
			workspace: Type.Optional(Type.String({ description: "Local collaboration workspace" })),
			task: Type.Optional(Type.String({ description: "Work request sent to peer agent, for start" })),
			approve: Type.Optional(Type.Boolean({ description: "For review: true to approve, false to request changes" })),
			notes: Type.Optional(Type.String({ description: "Review findings or approval summary" })),
		}),
		async execute(_toolCallId, args) {
			if (args.action === "start") {
				if (!args.reviewer || !args.workspace) throw new Error("reviewer and workspace are required to start");
				const data = await botFetch("/collabs/create", {
					method: "POST",
					body: JSON.stringify({ reviewer: args.reviewer, workspace: args.workspace, task: args.task || "" }),
				});
				const collab = data.collab as { id: string; workspaces: Record<string, string> };
				return {
					content: [
						{
							type: "text",
							text: `Started ${collab.id}. Git repository ready at ${args.workspace}; peer clone: ${collab.workspaces[String(args.reviewer)] || "created"}.`,
						},
					],
					details: {},
				};
			}
			if (args.action === "list") {
				const data = await botFetch("/collabs");
				return { content: [{ type: "text", text: JSON.stringify(data.collabs, null, 2) }], details: {} };
			}
			if (!args.id) throw new Error("id is required");
			if (args.action === "status") {
				const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}`);
				return { content: [{ type: "text", text: JSON.stringify(data.collab, null, 2) }], details: {} };
			}
			const status = await botFetch(`/collabs/${encodeURIComponent(args.id)}`);
			const collab = status.collab as {
				repo: string;
				workspaces: Record<string, string>;
				proposal?: { reviewer?: string; status?: string };
			};
			const workspace = args.workspace || collab.workspaces[process.env.SANDBOX_NAME || sandboxActor()];
			if (!workspace) throw new Error("workspace is required");
			const branch = `changes/${args.id}`;
			if (args.action === "propose") {
				try {
					git(workspace, ["remote", "set-url", "punch-collab", collab.repo]);
				} catch {
					git(workspace, ["remote", "add", "punch-collab", collab.repo]);
				}
				const head = git(workspace, ["rev-parse", "HEAD"]);
				git(workspace, ["push", "punch-collab", `HEAD:refs/heads/${branch}`]);
				const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}/propose`, {
					method: "POST",
					body: JSON.stringify({ head }),
				});
				const proposal = (data.collab as { proposal?: { reviewer?: string } }).proposal;
				return {
					content: [
						{ type: "text", text: `Proposed ${head}. Review requested from ${proposal?.reviewer ?? ""}.` },
					],
					details: {},
				};
			}
			git(workspace, ["fetch", "origin", branch]);
			const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}/review`, {
				method: "POST",
				body: JSON.stringify({ approve: args.approve === true, notes: args.notes || "" }),
			});
			const proposal = (data.collab as { proposal?: { status?: string } }).proposal;
			const text =
				proposal?.status === "merged"
					? "Approved. Matching approvals auto-merged into main."
					: args.approve
						? "Approved. Awaiting auto-merge."
						: "Changes requested.";
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "routines",
		label: "Punch routines",
		description: "Schedule reminders, automations, and heartbeat routines",
		promptSnippet: "Create/list/pause reminders and heartbeat routines",
		promptGuidelines: ["Use routines when the user asks for a reminder, recurring ping, or heartbeat automation."],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "remove", "pause", "resume"] as const),
			userId: Type.String({ description: "User ID owning the routine" }),
			channelId: Type.Optional(
				Type.String({ description: "Channel ID where the routine was requested (required for message/llm types)" }),
			),
			type: Type.Optional(StringEnum(["message", "llm", "heartbeat"] as const)),
			when: Type.Optional(Type.String({ description: "When to run (e.g. 30m, tomorrow 9am, every 6h)" })),
			text: Type.Optional(Type.String({ description: "Reminder text or prompt" })),
			recurrence: Type.Optional(
				Type.String({ description: "once, daily, weekly, every 30m, every 2h, or cron expression" }),
			),
			timezone: Type.Optional(Type.String({ description: "IANA timezone for interpreting when" })),
			id: Type.Optional(Type.String({ description: "Routine id for remove/pause/resume" })),
		}),
		async execute(_toolCallId, args) {
			if (args.action === "list") {
				const data = await botFetch(`/routines/list?userId=${encodeURIComponent(args.userId)}`);
				return { content: [{ type: "text", text: JSON.stringify(data.routines || [], null, 2) }], details: {} };
			}
			if (args.action === "remove") {
				if (!args.id) throw new Error("id is required for remove");
				const data = await botFetch(`/routines/${encodeURIComponent(args.id)}`, {
					method: "DELETE",
					body: JSON.stringify({ userId: args.userId }),
				});
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: {} };
			}
			if (args.action === "pause") {
				if (!args.id) throw new Error("id is required for pause");
				const data = await botFetch(`/routines/${encodeURIComponent(args.id)}/pause`, {
					method: "POST",
					body: JSON.stringify({ userId: args.userId }),
				});
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: {} };
			}
			if (args.action === "resume") {
				if (!args.id) throw new Error("id is required for resume");
				const data = await botFetch(`/routines/${encodeURIComponent(args.id)}/resume`, {
					method: "POST",
					body: JSON.stringify({ userId: args.userId }),
				});
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: {} };
			}
			const routineType = args.type || "message";
			if (routineType !== "heartbeat" && !args.channelId)
				throw new Error("channelId is required for create (except heartbeat type)");
			if (!args.text) throw new Error("text is required for create");
			if (!args.when) throw new Error("when is required for create");
			const data = await botFetch("/routines/create", {
				method: "POST",
				body: JSON.stringify({
					userId: args.userId,
					channelId: args.channelId || null,
					type: routineType,
					payload: args.text,
					when: args.when,
					recurrence: args.recurrence || "once",
					timezone: args.timezone || null,
				}),
			});
			return { content: [{ type: "text", text: JSON.stringify(data.routine, null, 2) }], details: {} };
		},
	});
}
