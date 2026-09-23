import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { createRemoteServiceBinding } from "@punch-bot/chord";
import { Client, createClientServiceTransport } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { expect, onTestFinished, test, vi } from "vitest";
import { DiscordAdapter } from "../src/gateway/discord.ts";
import { startGateway } from "../src/gateway/index.ts";
import { GatewaySessions, RuntimeTranscript, SandboxOperations } from "../src/services.ts";
import type { SupervisorClient } from "../src/supervisor/control.ts";
import { startSandboxRuntimeServer } from "../src/supervisor/runtime-server.ts";
import { Deferred } from "../src/testing/host.ts";

test("signed Discord interactions and WebSocket clients share sandbox execution across gateway restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-platform-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	const sandboxId = randomUUID(),
		generation = randomUUID(),
		token = "s".repeat(32);
	const runtime = await startSandboxRuntimeServer({
		directory: join(directory, "runtime"),
		models,
		model: faux.getModel(),
		sandboxId,
		generation,
		token,
		workspaceId: "workspace",
		hostname: "127.0.0.1",
		port: 0,
		onError,
	});
	onTestFinished(() => runtime.close());
	const summary = {
		id: sandboxId,
		workspaceId: "workspace",
		generation,
		container: "container",
		volume: "volume",
		desired: "running" as const,
		state: "ready" as const,
		deleteData: false,
	};
	const supervisor: SupervisorClient = {
		async create() {
			return summary;
		},
		async inspect() {
			return summary;
		},
		async acquire() {
			return { sandboxId, generation, token, url: runtime.url };
		},
		async stop() {
			throw new Error("Unexpected sandbox stop");
		},
		async delete() {
			throw new Error("Unexpected sandbox delete");
		},
	};
	const principal = {
		workspaceId: "workspace",
		userId: "user",
		permissions: ["sessions:read", "sessions:create", "sessions:control", "sessions:remove"],
	};
	const conversation = { platform: "discord", installationId: "10", conversationId: "20" };
	const keys = generateKeyPairSync("ed25519");
	const replies: { url: string; body: Record<string, unknown> }[] = [];
	const adapter = new DiscordAdapter({
		applicationId: "99",
		publicKey: keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
		botToken: "test",
		async resolvePrincipal() {
			return principal;
		},
		onError,
		async fetch(url, options) {
			replies.push({ url: String(url), body: JSON.parse(String(options?.body)) });
			return Response.json({ id: "100" });
		},
	});
	const httpServer = createServer();
	onTestFinished(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
	const options = {
		serverId: randomUUID(),
		databasePath: join(directory, "gateway.db"),
		supervisor,
		httpServer,
		websocket: {
			async authenticate() {
				return { principal, expiresAt: Date.now() + 60_000 };
			},
		},
		onError,
	};
	let gateway = await startGateway({ ...options, adapters: [adapter] });
	onTestFinished(() => gateway.close());
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	const connect = () =>
		Client.connect({
			serverId: options.serverId,
			transportFactory: createWebSocketTransportFactory({
				url: `ws://127.0.0.1:${address.port}/punch`,
				async getAccessToken() {
					return "test";
				},
			}),
		});
	let client = await connect();
	onTestFinished(() => client.dispose());
	let release = () => {};
	onTestFinished(() => release());
	const dispatch = async (id: string, name: string, values: Record<string, string>) => {
		const body = JSON.stringify({
			id,
			application_id: "99",
			type: 2,
			token: "test",
			guild_id: "10",
			channel_id: "20",
			channel: { type: 11 },
			member: { user: { id: "30" } },
			data: {
				name: "punch",
				options: [{ name, options: Object.entries(values).map(([name, value]) => ({ name, value })) }],
			},
		});
		const timestamp = String(Math.floor(Date.now() / 1000));
		return adapter.handle(
			new Request("https://gateway.test/discord", {
				method: "POST",
				body,
				headers: {
					"x-signature-timestamp": timestamp,
					"x-signature-ed25519": sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"),
				},
			}),
		);
	};
	try {
		const management = createRemoteServiceBinding({
			services: [GatewaySessions],
			transport: createClientServiceTransport(client, () => ({ serverId: options.serverId })),
			bound: true,
			assertAccess() {},
			onError,
		});
		await management.ready(BACKGROUND_CONTEXT);
		const session = await management.use(GatewaySessions).create(null, BACKGROUND_CONTEXT);
		await management.use(GatewaySessions).attach(session.sessionId, BACKGROUND_CONTEXT);
		const original = client;
		const binding = createRemoteServiceBinding({
			services: [SandboxOperations, RuntimeTranscript],
			transport: createClientServiceTransport(client, () => original.attachment),
			bound: true,
			assertAccess() {},
			onError,
		});
		await binding.ready(BACKGROUND_CONTEXT);
		expect((await dispatch("101", "attach", { session: session.sessionId })).status).toBe(200);
		await expect.poll(() => gateway.gateway.store.conversation(principal, conversation)).toBe(session.sessionId);
		faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage("shared answer");
			},
		]);
		await dispatch("102", "prompt", { text: "question" });
		await expect.poll(() => faux.state.callCount).toBe(1);
		expect(gateway.gateway.store.claim(principal, conversation, "102")).toMatchObject({
			status: "pending",
			result: { sessionId: session.sessionId, operationId: expect.any(String) },
		});
		await expect.poll(() => binding.use(RuntimeTranscript).state.value?.snapshot.operation?.id).toBeTypeOf("string");
		release();
		await expect
			.poll(
				() =>
					replies.some(
						(reply) => reply.url.includes("/webhooks/") && String(reply.body.content).includes('"accepted":true'),
					),
				{ timeout: 5000 },
			)
			.toBe(true);
		expect(replies.some((reply) => reply.url.includes("/channels/") && reply.body.content === "shared answer")).toBe(
			true,
		);
		await dispatch("102", "prompt", { text: "question" });
		await expect
			.poll(() => replies.some((reply) => String(reply.body.content).includes('"duplicate":true')))
			.toBe(true);
		expect(faux.state.callCount).toBe(1);
		faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage("aborted answer");
			},
		]);
		const presentation = await gateway.gateway.open({ principal, conversation, async send() {} });
		const turn = presentation.execute("abortable-prompt", { type: "prompt", text: "abort this turn" });
		try {
			await expect.poll(() => faux.state.callCount).toBe(2);
			const result = await presentation.execute("abort-current", { type: "abort" });
			expect(result).toMatchObject({ aborted: expect.any(String) });
			release();
			await expect(turn).resolves.toMatchObject({ accepted: true });
			await expect
				.poll(() => binding.use(RuntimeTranscript).state.value?.snapshot.lastResult?.status)
				.toBe("aborted");
		} finally {
			release();
			await presentation.close();
			await turn.catch(() => {});
		}
		// The next operation outlives the gateway process and its presentation connections.
		faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage("survived gateway restart");
			},
		]);
		await binding
			.use(SandboxOperations)
			.accept({ operationId: "survives", text: "keep working" }, BACKGROUND_CONTEXT);
		await expect.poll(() => faux.state.callCount).toBe(3);
		await binding.dispose(BACKGROUND_CONTEXT);
		await management.dispose(BACKGROUND_CONTEXT);
		await client.dispose();
		await gateway.close();
		release();
		gateway = await startGateway(options);
		client = await connect();
		await client.request(
			{ serverId: options.serverId },
			{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
		);
		await expect
			.poll(() =>
				client.request(client.attachment!, {
					serviceId: SandboxOperations.id,
					member: "status",
					args: ["survives"],
				}),
			)
			.toEqual({ operationId: "survives", status: "completed" });
		expect(gateway.gateway.store.conversation(principal, conversation)).toBe(session.sessionId);
		await client.request(
			{ serverId: options.serverId },
			{ serviceId: GatewaySessions.id, member: "remove", args: [session.sessionId] },
		);
		expect(
			await client.request(
				{ serverId: options.serverId },
				{ serviceId: GatewaySessions.id, member: "list", args: [] },
			),
		).toEqual([]);
		await expect(
			client.request(
				{ serverId: options.serverId },
				{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
			),
		).rejects.toThrow();
		expect(gateway.gateway.store.conversation(principal, conversation)).toBeUndefined();
		expect(errors).toEqual([]);
	} finally {
		release();
	}
}, 20_000);

test.each([
	"failed-send",
	"retry-send",
	"stalled-send",
	"failed-operation",
	"early-abort",
	"queued-abort",
	"queued-expiry",
	"stalled-admission",
])(
	"gateway handles %s without losing operation receipts",
	async (scenario) => {
		const directory = await mkdtemp(join(tmpdir(), "punch-platform-errors-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const faux = fauxProvider();
		const modelResponse = new Deferred<void>();
		onTestFinished(() => modelResponse.resolve());
		faux.setResponses([
			async () => {
				if (scenario === "early-abort" || scenario === "queued-abort" || scenario === "queued-expiry")
					await modelResponse.promise;
				if (scenario === "failed-operation")
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider authentication failed" });
				return fauxAssistantMessage("answer");
			},
			fauxAssistantMessage("queued answer"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const errors: unknown[] = [];
		const onError = (error: unknown) => errors.push(error);
		const sandboxId = randomUUID(),
			generation = randomUUID(),
			token = "s".repeat(32);
		const runtime = await startSandboxRuntimeServer({
			directory: join(directory, "runtime"),
			models,
			model: faux.getModel(),
			sandboxId,
			generation,
			token,
			workspaceId: "workspace",
			hostname: "127.0.0.1",
			port: 0,
			onError,
		});
		onTestFinished(() => runtime.close());
		const acquisition = new Deferred<void>();
		const acquiring = new Deferred<void>();
		onTestFinished(() => acquisition.resolve());
		const summary = {
			id: sandboxId,
			workspaceId: "workspace",
			generation,
			container: "container",
			volume: "volume",
			desired: "running" as const,
			state: "ready" as const,
			deleteData: false,
		};
		const supervisor: SupervisorClient = {
			async create() {
				return summary;
			},
			async inspect() {
				return summary;
			},
			async acquire() {
				acquiring.resolve();
				if (scenario === "early-abort" || scenario === "stalled-admission") await acquisition.promise;
				return { sandboxId, generation, token, url: runtime.url };
			},
			async stop() {
				throw new Error("Unexpected stop");
			},
			async delete() {
				throw new Error("Unexpected delete");
			},
		};
		const principal = {
			userId: "user",
			workspaceId: "workspace",
			permissions: ["sessions:read", "sessions:create", "sessions:control"],
		};
		const conversation = { platform: "test", installationId: "1", conversationId: "2" };
		const gateway = await startGateway({
			serverId: randomUUID(),
			databasePath: join(directory, "gateway.db"),
			supervisor,
			httpServer: createServer(),
			websocket: {
				async authenticate() {
					return { principal, expiresAt: Date.now() + 60_000 };
				},
			},
			onError,
		});
		onTestFinished(() => gateway.close());
		const sending = new Deferred<void>();
		const stalled = new Deferred<void>();
		let sendFailures = 0;
		onTestFinished(() => stalled.resolve());
		const presentation = await gateway.gateway.open({
			principal,
			conversation,
			async send(event) {
				if (
					!event.snapshot.lastResult ||
					scenario === "early-abort" ||
					scenario === "queued-abort" ||
					scenario === "queued-expiry"
				)
					return;
				sending.resolve();
				if (scenario === "failed-send" || (scenario === "retry-send" && sendFailures++ === 0))
					throw new Error("Delivery unavailable");
				if (scenario === "retry-send" || scenario === "failed-operation") return;
				await stalled.promise;
			},
		});
		onTestFinished(() => presentation.close());
		onTestFinished(() => {
			modelResponse.resolve();
			acquisition.resolve();
			stalled.resolve();
		});
		const deadlines: AbortController[] = [];
		if (scenario === "queued-expiry") {
			const timeout = AbortSignal.timeout;
			const mock = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
				if (ms !== 14 * 60_000) return timeout(ms);
				const deadline = new AbortController();
				deadlines.push(deadline);
				return deadline.signal;
			});
			onTestFinished(() => mock.mockRestore());
		}
		const turn = presentation.execute("prompt", { type: "prompt", text: "question" });
		void turn.catch(() => {});
		if (scenario === "early-abort") {
			await acquiring.promise;
			const abort = presentation.execute("abort", { type: "abort" });
			acquisition.resolve();
			expect(await abort).toMatchObject({ aborted: expect.any(String) });
			modelResponse.resolve();
			await expect(turn).resolves.toMatchObject({ accepted: true });
			expect(errors).toEqual([]);
		} else if (scenario === "stalled-admission") {
			await acquiring.promise;
			const status = presentation.execute("status", { type: "status" });
			const closing = presentation.close();
			await expect(status).rejects.toThrow("closed");
			acquisition.resolve();
			await closing;
			await expect(turn).rejects.toThrow();
		} else if (scenario === "queued-expiry") {
			await expect.poll(() => faux.state.callCount).toBe(1);
			const queued = presentation.execute("queued", { type: "prompt", text: "expired question" });
			deadlines[1]!.abort(new Error("Interaction deadline exceeded"));
			await expect(queued).rejects.toThrow("Interaction deadline exceeded");
			expect(gateway.gateway.store.claim(principal, conversation, "queued")).toBeUndefined();
			modelResponse.resolve();
			await expect(turn).resolves.toMatchObject({ accepted: true });
			expect(faux.state.callCount).toBe(1);
		} else if (scenario === "queued-abort") {
			await expect.poll(() => faux.state.callCount).toBe(1);
			const queued = presentation.execute("queued", { type: "prompt", text: "next question" });
			void queued.catch(() => {});
			expect(await presentation.execute("abort", { type: "abort" })).toMatchObject({ aborted: expect.any(String) });
			modelResponse.resolve();
			await expect(turn).resolves.toMatchObject({ accepted: true });
			await expect(queued).resolves.toMatchObject({ accepted: true });
			expect(errors).toEqual([]);
		} else {
			await sending.promise;
			if (scenario === "stalled-send") {
				await presentation.close();
				await expect(turn).rejects.toThrow("closed");
			} else if (scenario === "failed-operation") {
				await expect(turn).rejects.toThrow("Provider authentication failed");
			} else {
				await expect(turn).rejects.toThrow("Delivery unavailable");
			}
			expect(gateway.gateway.store.claim(principal, conversation, "prompt")).toMatchObject({
				status: "failed",
				result: { operationId: expect.any(String), sessionId: expect.any(String) },
			});
			if (scenario === "retry-send") {
				await expect(presentation.execute("status-after-retry", { type: "status" })).resolves.toMatchObject({
					sessionId: expect.any(String),
				});
				expect(errors.filter((error) => String(error).includes("Delivery unavailable"))).toHaveLength(1);
			}
		}
	},
	10_000,
);
