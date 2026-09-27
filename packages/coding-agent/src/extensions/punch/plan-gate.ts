// Plan gate: Punch's model-triggered, human-gated work approval.
//
// `propose_plan` is the model-side half of the gate: before multi-step or
// mutating work the model proposes a plan, the tool forwards it to the Punch
// bot through the sandbox supervisor (:4097), and the turn ends while a human
// decides on the posted card. The bot stamps `origin` (user vs a2a:<peer>)
// itself — it is deliberately not part of the schema the model can fill in.
//
// `createDeferredApprovalHook` is the policy-side counterpart ("belt to the
// model's suspenders" — the model can forget to call the tool; a hook cannot).
// It produces a `tool_call` handler that blocks gated tool calls while an
// external decision is pending. Hosts wire it to their own decision source
// (e.g. the bot's /plan/resolve endpoint) and register it with
// `pi.on("tool_call", ...)`. At the harness layer the equivalent seam is the
// `before_tool` hook (HookMap/HookHandler, exported from @punch-bot/agent).
//
// Deliberately absent in v1: true run suspension (suspend the lane, free the
// executor, resume on approval). That needs session create.restore + a
// human-decision lane.resume(), which the agent harness does not expose yet.
// End-turn + a fresh enqueued turn on approval is equivalent UX for a
// human-speed decision.

import type { AgentToolResult } from "@punch-bot/agent";
import { Type } from "typebox";

import type {
	ExtensionAPI,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";

const DEFAULT_SUPERVISOR_URL = "http://localhost:4097";

export interface PlanProposalResponse {
	planId?: string;
	/** "pending" = human must approve · "approved" = auto-approved · "denied" = do not run */
	decision?: "pending" | "approved" | "denied" | string;
	reason?: string;
}

export interface InstallPlanGateOptions {
	env?: NodeJS.ProcessEnv;
	/** POST helper for tests; production posts to the sandbox supervisor. */
	post?: (path: string, body: Record<string, unknown>) => Promise<PlanProposalResponse>;
}

/** The gate only exists inside a Punch sandbox (or when pointed at one). */
export function isPlanGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.PUNCH_PLAN_GATE_URL?.trim() || env.SANDBOX_NAME?.trim());
}

function supervisorAuthHeader(env: NodeJS.ProcessEnv): string {
	const user = env.PI_SERVER_USERNAME || env.OPENCODE_SERVER_USERNAME || "opencode";
	const pass = env.PI_SERVER_PASSWORD || env.OPENCODE_SERVER_PASSWORD || "";
	return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function postToSupervisor(
	env: NodeJS.ProcessEnv,
	path: string,
	body: Record<string, unknown>,
): Promise<PlanProposalResponse> {
	const base = (env.PUNCH_PLAN_GATE_URL || DEFAULT_SUPERVISOR_URL).replace(/\/+$/, "");
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: supervisorAuthHeader(env) },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let data: PlanProposalResponse;
	try {
		data = JSON.parse(text) as PlanProposalResponse;
	} catch {
		data = {};
	}
	if (!response.ok) {
		throw new Error(`plan gate ${response.status}: ${text.slice(0, 200)}`);
	}
	return data;
}

// A tool result that ends the turn. The agent loop terminates the run when
// every finalized tool result in the batch carries terminate: true.
function endTurn(text: string, details: PlanProposalResponse): AgentToolResult<PlanProposalResponse> {
	return { content: [{ type: "text", text }], details, terminate: true };
}

export function installPlanGate(pi: ExtensionAPI, options: InstallPlanGateOptions = {}): void {
	const env = options.env ?? process.env;
	if (!isPlanGateEnabled(env)) return;
	const post = options.post ?? ((path: string, body: Record<string, unknown>) => postToSupervisor(env, path, body));

	pi.registerTool({
		name: "propose_plan",
		label: "Propose plan",
		description:
			"Propose a plan for human approval before starting multi-step or mutating work. " +
			"Ends the turn pending approval; do not perform the proposed work until it is approved.",
		promptSnippet: "Propose a plan and wait for approval before multi-step or mutating work",
		promptGuidelines: [
			"Before starting multi-step or mutating work (file edits, running commands, project changes, anything > 1 tool call), call propose_plan with the plan. Do not perform the work until the plan is approved.",
			"Casual chat, questions, lookups, and anything the user explicitly said 'just do it' / 'no plan needed' bypass the gate.",
			"propose_plan ends the turn when approval is required — do not poll and do not proceed.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "One line, shown as the plan card title" }),
			steps: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 20,
				description: "Short imperative steps the plan will run",
			}),
			touch: Type.Optional(Type.Array(Type.String(), { description: "Files/dirs the plan will modify" })),
			commands: Type.Optional(Type.Array(Type.String(), { description: "Shell commands the plan intends to run" })),
			est: Type.Optional(Type.String({ description: "Concrete estimate, e.g. '~2 min'" })),
		}),
		async execute(_toolCallId, args) {
			const body = {
				summary: args.summary,
				steps: args.steps,
				touch: args.touch ?? [],
				commands: args.commands ?? [],
				est: args.est ?? null,
			};
			let response: PlanProposalResponse;
			try {
				response = await post("/plan/propose", body);
			} catch (err) {
				// No decision, no execution: end the turn rather than run ungated.
				return endTurn(`Plan gate unreachable (${(err as Error).message}). Turn ended; retry later.`, {});
			}
			if (response.decision === "approved") {
				return {
					content: [
						{
							type: "text",
							text: `Plan ${response.planId ?? ""} auto-approved — proceed with the proposed work.`,
						},
					],
					details: response,
				};
			}
			if (response.decision === "pending") {
				return endTurn(
					`Plan ${response.planId ?? ""} proposed — awaiting approval. Do not proceed with the proposed work.`,
					response,
				);
			}
			const reason = response.reason ? ` (${response.reason})` : "";
			return endTurn(
				`Plan ${response.planId ?? ""} denied${reason} — do not proceed with the proposed work.`,
				response,
			);
		},
	});
}

export type DeferredApprovalDecision =
	| { status: "approved" }
	| { status: "pending"; reason?: string }
	| { status: "denied"; reason?: string };

export interface DeferredApprovalOptions {
	/** Tool names that bypass the decision check (e.g. read-only lookups). */
	exemptToolNames?: readonly string[];
	/** Consult the external decision source for this tool call. */
	decide: (event: ToolCallEvent) => Promise<DeferredApprovalDecision> | DeferredApprovalDecision;
}

/** `tool_call` handler signature produced by createDeferredApprovalHook. */
export type DeferredApprovalHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

// Reference implementation of "defer execution pending external decision".
// Register the returned handler via pi.on("tool_call", handler) so a host can
// enforce the gate policy-side even when the model forgets to call
// propose_plan. pending blocks the call and terminates the batch (turn ends,
// work is not started); denied blocks without terminating (the model sees the
// refusal and can react); approved lets the call execute.
export function createDeferredApprovalHook(options: DeferredApprovalOptions): DeferredApprovalHandler {
	const exempt = new Set(options.exemptToolNames ?? []);
	return async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
		if (exempt.has(event.toolName)) return;
		const decision = await options.decide(event);
		if (decision.status === "approved") return;
		if (decision.status === "pending") {
			return {
				block: true,
				reason: decision.reason ?? "Execution deferred pending external approval.",
				terminate: true,
			};
		}
		return { block: true, reason: decision.reason ?? "Execution denied by the plan gate." };
	};
}
