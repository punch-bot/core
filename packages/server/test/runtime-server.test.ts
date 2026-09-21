import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { createRemoteServiceBinding } from "@punch-bot/chord";
import { Client, createClientServiceTransport } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { expect, test } from "vitest";
import { withPrincipal } from "../src/principal.ts";
import { RuntimeSessions, SandboxOperations } from "../src/services.ts";
import { signRuntimeCapability } from "../src/supervisor/capability.ts";
import { createRemoteSessionHandle } from "../src/supervisor/remote-session.ts";
import { startSandboxRuntimeServer } from "../src/supervisor/runtime-server.ts";

test("authenticates remote runtime calls and preserves operations after presentation disconnect", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-runtime-ws-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("remote sandbox answer")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const sandboxId = randomUUID();
	const generation = randomUUID();
	const token = "s".repeat(32);
	const errors: unknown[] = [];
	const runtime = await startSandboxRuntimeServer({
		directory,
		models,
		model: faux.getModel(),
		sandboxId,
		generation,
		token,
		workspaceId: "workspace",
		hostname: "127.0.0.1",
		port: 0,
		onError: (error) => errors.push(error),
	});
	const connect = async (workspaceId: string) =>
		Client.connect({
			serverId: sandboxId,
			transportFactory: createWebSocketTransportFactory({
				url: `${runtime.url.replace("http:", "ws:")}/punch`,
				async getAccessToken() {
					return signRuntimeCapability(token, generation, {
						workspaceId,
						userId: "user",
						permissions: ["sessions:read", "sessions:create", "sessions:control"],
					});
				},
			}),
		});
	let client: Client | undefined;
	try {
		expect((await fetch(`${runtime.url}/ready`)).status).toBe(401);
		await expect(connect("other")).rejects.toThrow();
		client = await connect("workspace");
		const management = createRemoteServiceBinding({
			services: [RuntimeSessions],
			transport: createClientServiceTransport(client, () => ({ serverId: sandboxId })),
			bound: true,
			assertAccess() {},
			onError: (error) => errors.push(error),
		});
		await management.ready(BACKGROUND_CONTEXT);
		const session = await management.use(RuntimeSessions).create(BACKGROUND_CONTEXT);
		await management.use(RuntimeSessions).attach(session.id, BACKGROUND_CONTEXT);
		const connected = client;
		const operations = createRemoteServiceBinding({
			services: [SandboxOperations],
			transport: createClientServiceTransport(client, () => connected.attachment),
			bound: true,
			assertAccess() {},
			onError: (error) => errors.push(error),
		});
		await operations.ready(BACKGROUND_CONTEXT);
		await operations
			.use(SandboxOperations)
			.accept({ operationId: "remote-operation", text: "question" }, BACKGROUND_CONTEXT);
		await client.dispose();
		client = await connect("workspace");
		const reconnected = client;
		const newManagement = createRemoteServiceBinding({
			services: [RuntimeSessions],
			transport: createClientServiceTransport(client, () => ({ serverId: sandboxId })),
			bound: true,
			assertAccess() {},
			onError: (error) => errors.push(error),
		});
		await newManagement.ready(BACKGROUND_CONTEXT);
		await newManagement.use(RuntimeSessions).attach(session.id, BACKGROUND_CONTEXT);
		const newOperations = createRemoteServiceBinding({
			services: [SandboxOperations],
			transport: createClientServiceTransport(client, () => reconnected.attachment),
			bound: true,
			assertAccess() {},
			onError: (error) => errors.push(error),
		});
		await newOperations.ready(BACKGROUND_CONTEXT);
		await expect
			.poll(
				async () =>
					(await newOperations.use(SandboxOperations).status("remote-operation", BACKGROUND_CONTEXT)).status,
			)
			.toBe("completed");
		let allowed = true;
		let currentGeneration = generation;
		const context = withPrincipal(
			{ userId: "user", workspaceId: "workspace", permissions: ["sessions:read", "sessions:control"] },
			BACKGROUND_CONTEXT,
		);
		const handle = createRemoteSessionHandle({
			sandboxId,
			sessionId: session.id,
			workspaceId: "workspace",
			async authorize() {
				if (!allowed) throw new Error("Session access revoked");
			},
			supervisor: {
				async acquire() {
					return { sandboxId, generation, token, url: runtime.url };
				},
				async inspect() {
					return {
						id: sandboxId,
						workspaceId: "workspace",
						generation: currentGeneration,
						container: "container",
						volume: "volume",
						desired: "running",
						state: "ready",
						deleteData: false,
					};
				},
			},
		});
		try {
			const attachment = await handle.attachClient(context);
			const call = { serviceId: SandboxOperations.id, member: "status", args: ["remote-operation"] };
			expect(await attachment.invokeService(call, async () => {}, context)).toEqual({
				operationId: "remote-operation",
				status: "completed",
			});
			allowed = false;
			await expect(attachment.invokeService(call, async () => {}, context)).rejects.toThrow("revoked");
			allowed = true;
			currentGeneration = randomUUID();
			await expect(attachment.invokeService(call, async () => {}, context)).rejects.toThrow("stale");
		} finally {
			await handle.close(context);
		}
	} finally {
		await client?.dispose();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
