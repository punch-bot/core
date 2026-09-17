import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { Client } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { expect, test, vi } from "vitest";
import { startGateway } from "../src/experimental/gateway/index.ts";
import * as processRuntime from "../src/experimental/process.ts";
import { SessionManagement } from "../src/experimental/services/sessions.ts";
import { createServerServiceBinding } from "./experimental-service-binding.ts";

test("starts the real gateway backend and shares a durable faux-worker session over WebSocket", async () => {
	// Keep the root short: the backend creates unix sockets whose paths must fit sun_path.
	const root = await mkdtemp("/tmp/pg-");
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	const spawn = processRuntime.spawnInternalProcess;
	const spawner = vi
		.spyOn(processRuntime, "spawnInternalProcess")
		.mockImplementation((role, args, options) =>
			spawn(
				role,
				args,
				role === "session-worker"
					? { ...options, entryUrl: new URL("fixtures/faux-session-worker.ts", import.meta.url) }
					: options,
			),
		);
	const http = createServer();
	const principal = {
		userId: "alice",
		workspaceId: "one",
		permissions: ["sessions:read", "sessions:create", "sessions:control"],
	};
	const errors: unknown[] = [];
	let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
	let client: Client | undefined;
	try {
		runtime = await startGateway({
			databasePath: join(root, "gateway.db"),
			backend: {
				directory: join(root, "s"),
				sessionDir: join(root, "sessions"),
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			httpServer: http,
			websocket: { authenticate: async () => ({ principal, expiresAt: Date.now() + 60_000 }) },
			onError: (error) => errors.push(error),
		});
		http.listen(0, "127.0.0.1");
		await once(http, "listening");
		client = await Client.connect({
			serverId: runtime.serverId,
			transportFactory: createWebSocketTransportFactory({
				url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/punch`,
				getAccessToken: async () => "test",
			}),
		});
		const services = createServerServiceBinding(client, { services: [SessionManagement] });
		try {
			await services.ready(BACKGROUND_CONTEXT);
			const management = services.use(SessionManagement);
			const created = await management.create({}, BACKGROUND_CONTEXT);
			await management.attach(created.sessionId, BACKGROUND_CONTEXT);
			const replies: string[] = [];
			const presentation = await runtime.gateway.open({
				principal,
				conversation: { platform: "discord", installationId: "10", conversationId: "20" },
				async send(event) {
					for (const entry of event.snapshot.transcript) {
						if (entry.type === "message" && entry.message.role === "assistant")
							replies.push(
								entry.message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join(""),
							);
					}
				},
			});
			await presentation.execute("attach", { type: "attach", sessionId: created.sessionId });
			await expect(presentation.execute("prompt", { type: "prompt", text: "hello" })).resolves.toMatchObject({
				accepted: true,
				sessionId: created.sessionId,
			});
			expect(replies).toContain("deterministic remote answer");
			expect(client.attachment?.sessionId).toBe(created.sessionId);
			expect(errors).toEqual([]);
			await presentation.close();
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
		}
	} finally {
		await client?.dispose();
		await runtime?.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		spawner.mockRestore();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
