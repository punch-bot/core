import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createA2aServer, LocalA2aDiscovery } from "@punch-bot/a2a";
import { afterEach, describe, expect, it } from "vitest";

import type { ContextEvent, ContextEventResult, ExtensionAPI, ExtensionHandler } from "../src/core/extensions/index.ts";
import { formatA2aPeers, installA2a, isPunchA2aEnabled, punchSandboxName } from "../src/extensions/punch/a2a.ts";

type ContextHandler = ExtensionHandler<ContextEvent, ContextEventResult>;

interface ToolDefinition {
	name: string;
	execute?: (
		callId: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}

function setup(env: NodeJS.ProcessEnv, discovery?: LocalA2aDiscovery) {
	const handlers = new Map<string, unknown>();
	const tools: ToolDefinition[] = [];
	const api = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	installA2a(api, { env, discovery });

	return {
		tools,
		contextHandler: handlers.get("context") as ContextHandler | undefined,
		a2aTool: tools.find((candidate) => candidate.name === "a2a"),
	};
}

describe("isPunchA2aEnabled", () => {
	it("defaults off without SANDBOX_NAME", () => {
		expect(isPunchA2aEnabled({})).toBe(false);
	});

	it("enables for sandboxes unless PUNCH_A2A=0", () => {
		expect(isPunchA2aEnabled({ SANDBOX_NAME: "alice" })).toBe(true);
		expect(isPunchA2aEnabled({ SANDBOX_NAME: "alice", PUNCH_A2A: "0" })).toBe(false);
		expect(isPunchA2aEnabled({ PUNCH_A2A: "1" })).toBe(true);
	});
});

describe("punchSandboxName", () => {
	it("prefers SANDBOX_NAME", () => {
		expect(punchSandboxName({ SANDBOX_NAME: " alice ", PI_SERVER_USERNAME: "bob" })).toBe("alice");
	});
});

describe("installA2a", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not register the tool when discovery is disabled", () => {
		const { tools } = setup({});
		expect(tools).toEqual([]);
	});

	it("lists and sends to a discovered local sandbox", async () => {
		const dir = mkdtempSync(join(tmpdir(), "punch-a2a-"));
		dirs.push(dir);
		const aliceDiscovery = new LocalA2aDiscovery({ dir, isAlive: () => true });
		const bobDiscovery = new LocalA2aDiscovery({ dir, isAlive: () => true });
		const server = await createA2aServer({
			name: "bob",
			runnerFactory: () => ({
				async prompt(text) {
					return { text: `from-bob:${text}` };
				},
			}),
		});
		const bound = await server.listen(0, "127.0.0.1");
		try {
			bobDiscovery.advertise({
				id: "bob-id",
				name: "bob",
				url: bound.url,
				pid: process.pid + 1,
				startedAt: Date.now(),
			});
			const { a2aTool, contextHandler } = setup({ SANDBOX_NAME: "alice" }, aliceDiscovery);
			expect(a2aTool).toBeDefined();

			const listed = await a2aTool!.execute!("call", { action: "list" }, undefined, undefined, {});
			expect(listed.content[0]?.text).toContain("bob");
			expect(listed.content[0]?.text).toContain(bound.url);

			const context = contextHandler?.({ type: "context", messages: [] }, {} as never) as
				| ContextEventResult
				| undefined;
			expect(
				context?.messages?.some((message) => "customType" in message && message.customType === "punch-a2a-peers"),
			).toBe(true);

			const sent = await a2aTool!.execute!(
				"call",
				{ action: "send", name: "Bob", task: "ping" },
				undefined,
				undefined,
				{},
			);
			expect(sent.content[0]?.text).toBe("from-bob:ping");
		} finally {
			aliceDiscovery.close();
			bobDiscovery.close();
			await server.close();
		}
	});

	it("formats an empty peer list", () => {
		expect(formatA2aPeers([])).toBe("No other punch sandboxes discovered on this machine.");
	});
});
