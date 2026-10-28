import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";
import {
	createDeferredApprovalHook,
	installPlanGate,
	type PlanProposalResponse,
} from "../src/extensions/punch/plan-gate.ts";

interface ToolDefinition {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: { required?: string[]; properties?: Record<string, unknown> };
	execute?: (
		callId: string,
		args: Record<string, unknown>,
		_signal: unknown,
		_onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown; terminate?: boolean }>;
}

function setup(responses: PlanProposalResponse[] | Error[], env: NodeJS.ProcessEnv = { SANDBOX_NAME: "ember" }) {
	const tools: ToolDefinition[] = [];
	const api = {
		on(_event: string, _handler: unknown) {},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	const post = vi.fn(async (_path: string, _body: Record<string, unknown>) => {
		const next = responses.shift();
		if (next instanceof Error) throw next;
		if (!next) throw new Error("no response queued");
		return next;
	});

	installPlanGate(api, { env, post });
	return { tools, post, tool: tools.find((candidate) => candidate.name === "propose_plan") };
}

const args = {
	summary: "convert app to Comic Sans",
	steps: ["add @font-face imports", "swap font-family tokens", "rebuild"],
	touch: ["src/styles/**"],
	commands: ["npm run build"],
	est: "~5 min",
};

describe("propose_plan", () => {
	it("registers with the plan-gate prompt contract", () => {
		const { tool } = setup([]);
		expect(tool).toBeDefined();
		expect(tool?.promptSnippet).toContain("plan");
		expect(tool?.promptGuidelines?.join(" ")).toContain("propose_plan");
		// origin is set by harness glue, never by the model
		expect(tool?.parameters?.properties).not.toHaveProperty("origin");
		expect(tool?.parameters?.required).toEqual(["summary", "steps"]);
	});

	it("does not install outside a Punch sandbox", () => {
		const { tool } = setup([], {});
		expect(tool).toBeUndefined();
	});

	it("posts the proposal and ends the turn when decision is pending", async () => {
		const { tool, post } = setup([{ planId: "pl_1", decision: "pending" }]);
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(post).toHaveBeenCalledWith(
			"/plan/propose",
			{
				summary: args.summary,
				steps: args.steps,
				touch: args.touch,
				commands: args.commands,
				est: args.est,
			},
			undefined,
		);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("awaiting approval");
	});

	it("lets the turn continue when decision is approved", async () => {
		const { tool } = setup([{ planId: "pl_2", decision: "approved" }]);
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(result?.terminate).toBeUndefined();
		expect(result?.content[0]?.text).toContain("proceed");
	});

	it("ends the turn when the plan is denied", async () => {
		const { tool } = setup([{ planId: "pl_3", decision: "denied", reason: "rate limit" }]);
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("denied");
		expect(result?.content[0]?.text).toContain("rate limit");
	});

	it("fails closed when the gate is unreachable", async () => {
		const { tool } = setup([new Error("ECONNREFUSED")]);
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("unreachable");
	});
});

describe("createDeferredApprovalHook", () => {
	const toolCall = (toolName: string): ToolCallEvent => ({
		type: "tool_call",
		toolCallId: "c1",
		toolName,
		input: {},
	});

	it("lets approved calls execute", async () => {
		const hook = createDeferredApprovalHook({ decide: () => ({ status: "approved" }) });
		expect(await hook(toolCall("bash"), {} as never)).toBeUndefined();
	});

	it("blocks and terminates the batch while a decision is pending", async () => {
		const hook = createDeferredApprovalHook({
			decide: () => ({ status: "pending", reason: "awaiting plan approval" }),
		});
		expect(await hook(toolCall("write"), {} as never)).toEqual({
			block: true,
			reason: "awaiting plan approval",
			terminate: true,
		});
	});

	it("blocks without terminating when denied", async () => {
		const hook = createDeferredApprovalHook({ decide: () => ({ status: "denied" }) });
		const result = (await hook(toolCall("write"), {} as never)) as { block?: boolean; terminate?: boolean };
		expect(result.block).toBe(true);
		expect(result.terminate).toBeUndefined();
	});

	it("skips exempt tools entirely", async () => {
		const decide = vi.fn(() => ({ status: "pending" as const }));
		const hook = createDeferredApprovalHook({ decide, exemptToolNames: ["read"] });
		expect(await hook(toolCall("read"), {} as never)).toBeUndefined();
		expect(decide).not.toHaveBeenCalled();
	});
});

describe("propose_plan supervisor transport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function setupWithFetch(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
		const tools: ToolDefinition[] = [];
		const api = {
			on(_event: string, _handler: unknown) {},
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const fetchMock = vi.fn(fetchImpl);
		vi.stubGlobal("fetch", fetchMock);
		installPlanGate(api, { env: { PUNCH_PLAN_GATE_URL: "http://supervisor.test/" } });
		return { fetchMock, tool: tools.find((candidate) => candidate.name === "propose_plan") };
	}

	it("posts to the supervisor and ends the turn on a non-2xx response", async () => {
		const { tool, fetchMock } = setupWithFetch(async () => new Response("supervisor down", { status: 503 }));
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://supervisor.test/plan/propose");
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("unreachable");
		expect(result?.content[0]?.text).toContain("503");
	});

	it("fails closed when the response has no decision", async () => {
		const { tool } = setupWithFetch(async () => Response.json({ planId: "pl_4" }));
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("do not proceed");
	});

	it("fails closed on an unknown decision", async () => {
		const { tool } = setupWithFetch(async () => Response.json({ planId: "pl_5", decision: "maybe" }));
		const result = await tool?.execute?.("call-1", args, undefined, undefined, undefined);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("do not proceed");
	});

	it("aborts the request with the tool signal and ends the turn", async () => {
		const { tool, fetchMock } = setupWithFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const controller = new AbortController();
		const pending = tool?.execute?.("call-1", args, controller.signal, undefined, undefined);
		controller.abort();
		const result = await pending;
		expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
		expect(result?.terminate).toBe(true);
		expect(result?.content[0]?.text).toContain("unreachable");
	});
});
