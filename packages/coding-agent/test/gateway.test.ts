import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneTranscriptSnapshot, MemorySessionRepo } from "@punch-bot/agent";
import {
	createRemoteServiceEndpoint,
	decodeServiceControlCall,
	type JsonValue,
	RemoteServiceProvider,
	replicatedState,
} from "@punch-bot/chord";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { Client } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { getPrincipal, type Principal, Server, withPrincipal } from "@punch-bot/server";
import { createWebSocketListener } from "@punch-bot/server/websocket";
import { afterEach, expect, test, vi } from "vitest";
import { DiscordAdapter } from "../src/experimental/gateway/discord.ts";
import { Gateway } from "../src/experimental/gateway/runtime.ts";
import { GatewayStore } from "../src/experimental/gateway/store.ts";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { Models, type ModelsState } from "../src/experimental/services/models.ts";
import { createExperimentalServerServices } from "../src/experimental/services/server.ts";
import { SessionDirectory, SessionManagement } from "../src/experimental/services/sessions.ts";
import { Transcript, type TranscriptState } from "../src/experimental/services/transcript.ts";
import { createServerServiceBinding } from "./experimental-service-binding.ts";

const alice: Principal = {
	userId: "alice",
	workspaceId: "one",
	permissions: ["sessions:read", "sessions:create", "sessions:control", "sessions:remove"],
};
const bob: Principal = { ...alice, userId: "bob", workspaceId: "two" };
const conversation = { platform: "discord", installationId: "10", conversationId: "20" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});

async function fixture(
	options: { deferPromptCompletionSnapshot?: boolean; omitPromptCompletionResult?: boolean } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "punch-gateway-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const store = new GatewayStore(join(directory, "gateway.db"));
	let storeClosed = false;
	const closeStore = (): void => {
		if (storeClosed) return;
		storeClosed = true;
		store.close();
	};
	const repo = new MemorySessionRepo();
	const serverId = randomUUID();
	const services = await createExperimentalServerServices({
		access: store,
		list: async (context) =>
			(await repo.list(undefined, context)).map((metadata) => ({
				serverId,
				sessionId: metadata.id,
				createdAt: metadata.createdAt,
			})),
		create: async (_, context) => {
			const session = await repo.create({ id: randomUUID() }, context);
			await session.close(context);
			return { serverId, sessionId: session.metadata.id, createdAt: session.metadata.createdAt };
		},
		remove: async (id, context) => {
			const metadata = (await repo.list(undefined, context)).find((session) => session.id === id)!;
			await repo.delete(metadata, context);
		},
		prepareSessionPlugins: async () => ({ packagePaths: [], presentationPlugins: null }),
		reloadPresentationPlugins: async () => null,
	});
	const snapshot: LaneTranscriptSnapshot = {
		lane: "main",
		transcript: [],
		tipId: null,
		configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off", activeToolNames: [] },
		stats: {
			messageCount: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		operation: null,
		queues: [],
		faulted: false,
	};
	const transcript = replicatedState<TranscriptState>({ snapshot, event: null });
	const models = replicatedState<ModelsState>({
		catalog: { revision: 1, availableModels: [] },
		configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
		refresh: { status: "idle" },
	});
	let finish: (() => void) | undefined;
	let publishPromptCompletion: (() => void) | undefined;
	let markPromptReturned!: () => void;
	const promptReturned = new Promise<void>((resolve) => {
		markPromptReturned = resolve;
	});
	const completePrompt = (): void => {
		transcript.state.snapshot!.operation = null;
		if (!options.omitPromptCompletionResult) {
			transcript.state.snapshot!.lastResult = {
				operationId: "turn",
				kind: "run",
				status: "completed",
				fromTipId: null,
				tipId: "final",
				startedAt: 1,
				endedAt: 2,
			};
		}
		transcript.publish(BACKGROUND_CONTEXT);
	};
	const prompt = vi.fn(async () => {
		transcript.state.snapshot!.operation = {
			id: "turn",
			kind: "run",
			startedAt: 1,
			fromTipId: null,
			status: "running",
			runningTools: [],
		};
		transcript.publish(BACKGROUND_CONTEXT);
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		if (options.deferPromptCompletionSnapshot) publishPromptCompletion = completePrompt;
		else completePrompt();
		markPromptReturned();
		return { accepted: true as const, operationId: "turn", error: null };
	});
	const unsupported = async (): Promise<never> => {
		throw new Error("Unsupported test operation");
	};
	const agent: AgentController = {
		prompt,
		requestAbort: async () => {
			finish?.();
		},
		steer: unsupported,
		followUp: unsupported,
		nextRun: unsupported,
		cancelQueued: unsupported,
		resume: unsupported,
		compact: unsupported,
		navigate: unsupported,
	};
	const http = createServer();
	const listener = createWebSocketListener({
		server: http,
		authenticate: async (request) => ({
			principal: request.headers.authorization === "Bearer bob" ? bob : alice,
			expiresAt: Date.now() + 60_000,
		}),
	});
	const server = new Server(
		{
			serverServices: services.host,
			authorizeSession: (id, call, context) =>
				store.authorize(
					call === undefined || decodeServiceControlCall(call) !== undefined
						? "sessions:read"
						: "sessions:control",
					id,
					context,
				),
			resolveSession: async (id, context) => {
				const metadata = (await repo.list(undefined, context)).find((session) => session.id === id);
				if (!metadata) throw new Error("Missing session");
				return metadata;
			},
			openSession: async () => ({
				attachClient() {
					const provider = new RemoteServiceProvider([AgentController, Models, Transcript]);
					provider.provide(AgentController, agent);
					provider.provide(Transcript, { state: transcript });
					provider.provide(Models, {
						state: models,
						select: async (model) => {
							models.state.configuration.model = model;
							models.publish(BACKGROUND_CONTEXT);
						},
						selectThinking: unsupported,
						cycleThinking: unsupported,
						refresh: unsupported,
						getThinkingLevels: unsupported,
					});
					const endpoint = createRemoteServiceEndpoint(provider);
					return {
						invokeService: endpoint.invoke,
						release: () => {
							endpoint.dispose();
							provider.dispose();
						},
					};
				},
				async close() {},
			}),
		},
		{ serverId, listeners: [listener] },
	);
	await server.start();
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const gateway = new Gateway({
		server,
		store,
		onError: (error) => {
			throw error;
		},
	});
	cleanup.push(async () => {
		finish?.();
		await gateway.close();
		await server.close();
		await services.dispose();
		await repo.close(BACKGROUND_CONTEXT);
		closeStore();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	});
	const connect = async (token: string) => {
		const client = await Client.connect({
			serverId,
			transportFactory: createWebSocketTransportFactory({
				url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/punch`,
				getAccessToken: async () => token,
			}),
		});
		cleanup.push(() => client.dispose());
		const binding = createServerServiceBinding(client, { services: [SessionDirectory, SessionManagement] });
		await binding.ready(BACKGROUND_CONTEXT);
		cleanup.push(() => binding.dispose(BACKGROUND_CONTEXT));
		return { client, management: binding.use(SessionManagement), directory: binding.use(SessionDirectory) };
	};
	return {
		gateway,
		store,
		services,
		directory,
		prompt,
		promptReturned,
		publishPromptCompletion: () => publishPromptCompletion?.(),
		transcript,
		connect,
		closeStore,
	};
}

test("isolates directory snapshots and blocks cross-workspace attach and removal", async () => {
	const runtime = await fixture();
	const a = await runtime.connect("alice");
	const b = await runtime.connect("bob");
	const created = await a.management.create({}, BACKGROUND_CONTEXT);
	await a.management.attach(created.sessionId, BACKGROUND_CONTEXT);
	await expect.poll(() => a.directory.state.value?.sessions.length).toBe(1);
	expect(b.directory.state.value?.sessions).toEqual([]);
	await expect(b.management.attach(created.sessionId, BACKGROUND_CONTEXT)).rejects.toMatchObject({
		code: "service_not_allowed",
	});
	await expect(b.management.remove(created.sessionId, BACKGROUND_CONTEXT)).rejects.toMatchObject({
		code: "service_not_allowed",
	});
	expect(a.client.attachment?.sessionId).toBe(created.sessionId);
	runtime.store.bind(alice, conversation, created.sessionId);
	await a.management.remove(created.sessionId, BACKGROUND_CONTEXT);
	expect(runtime.store.conversation(alice, conversation)).toBeUndefined();
	await expect(
		runtime.store.authorize("sessions:read", created.sessionId, withPrincipal(alice, BACKGROUND_CONTEXT)),
	).rejects.toThrow("access denied");
	await expect.poll(() => a.directory.state.value?.sessions).toEqual([]);
});

test("isolates failed directory projections after a committed mutation", async () => {
	const runtime = await fixture();
	const a = await runtime.connect("alice");
	const b = await runtime.connect("bob");
	const canAccess = runtime.store.canAccess.bind(runtime.store);
	vi.spyOn(runtime.store, "canAccess").mockImplementation(async (permission, sessionId, context) => {
		if (getPrincipal(context)?.userId === "bob") throw new Error("projection failed");
		return canAccess(permission, sessionId, context);
	});
	await expect(a.management.create({}, BACKGROUND_CONTEXT)).resolves.toMatchObject({ sessionId: expect.any(String) });
	await expect.poll(() => a.directory.state.value?.sessions.length).toBe(1);
	expect(b.directory.state.value?.sessions).toEqual([]);
});

test("Android and a platform presentation control the same session, including abort during a prompt", async () => {
	const runtime = await fixture();
	const android = await runtime.connect("alice");
	const session = await android.management.create({}, BACKGROUND_CONTEXT);
	await android.management.attach(session.sessionId, BACKGROUND_CONTEXT);
	const presentation = await runtime.gateway.open({ principal: alice, conversation, async send() {} });
	await presentation.execute("attach", { type: "attach", sessionId: session.sessionId });
	const running = presentation.execute("prompt", { type: "prompt", text: "hello" });
	await expect.poll(() => runtime.prompt.mock.calls.length).toBe(1);
	await expect(presentation.execute("abort", { type: "abort" })).resolves.toMatchObject({ aborted: "turn" });
	await expect(running).resolves.toMatchObject({ accepted: true, sessionId: session.sessionId });
	await expect(presentation.execute("prompt", { type: "prompt", text: "hello" })).resolves.toMatchObject({
		duplicate: true,
		status: "completed",
	});
	expect(runtime.prompt).toHaveBeenCalledTimes(1);
	expect(android.client.attachment?.sessionId).toBe(session.sessionId);
});

test("waits for the final transcript snapshot before completing a prompt", async () => {
	const runtime = await fixture({ deferPromptCompletionSnapshot: true });
	const snapshots: LaneTranscriptSnapshot[] = [];
	const presentation = await runtime.gateway.open({
		principal: alice,
		conversation,
		async send(event) {
			snapshots.push(event.snapshot);
		},
	});
	await presentation.execute("new", { type: "new" });
	const running = presentation.execute("prompt", { type: "prompt", text: "hello" });
	await expect.poll(() => runtime.prompt.mock.calls.length).toBe(1);
	await presentation.execute("abort-final-snapshot", { type: "abort" });
	await runtime.promptReturned;
	let settled = false;
	void running.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	runtime.publishPromptCompletion();
	await expect(running).resolves.toMatchObject({ accepted: true, operationId: "turn" });
	expect(snapshots.at(-1)?.lastResult?.operationId).toBe("turn");
});

test("releases the command queue when an operation clears without a completion snapshot", async () => {
	const runtime = await fixture({ omitPromptCompletionResult: true });
	const presentation = await runtime.gateway.open({ principal: alice, conversation, async send() {} });
	await presentation.execute("new", { type: "new" });
	const running = presentation.execute("prompt", { type: "prompt", text: "hello" });
	await expect.poll(() => runtime.prompt.mock.calls.length).toBe(1);
	await presentation.execute("abort-missing-result", { type: "abort" });
	await expect(running).rejects.toThrow("ended without a completion snapshot");
	await expect(presentation.execute("new-after-missing-result", { type: "new" })).resolves.toMatchObject({
		sessionId: expect.any(String),
	});
});

test("persists conversation bindings and uncertain event claims across restarts", async () => {
	const runtime = await fixture();
	runtime.store.bind(alice, conversation, "session");
	expect(runtime.store.claim(alice, conversation, "event")).toBeUndefined();
	runtime.closeStore();
	const second = new GatewayStore(join(runtime.directory, "gateway.db"));
	try {
		expect(second.conversation(alice, conversation)).toBe("session");
		expect(second.conversation(bob, conversation)).toBeUndefined();
		expect(second.claim(alice, conversation, "event")).toEqual({ status: "pending", result: null });
		await expect(
			second.authorize("sessions:read", "session", withPrincipal(alice, BACKGROUND_CONTEXT)),
		).rejects.toThrow("access denied");
	} finally {
		second.close();
	}
});

test("disposal rejects late service invocations while draining admitted work", async () => {
	const runtime = await fixture();
	const context = withPrincipal(alice, BACKGROUND_CONTEXT);
	const attachment = await runtime.services.host.attachClient(
		{
			attachSession: async () => {},
			detachSession: async () => {},
			prepareSessionRemoval: async () => {},
		},
		context,
	);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const authorize = runtime.store.authorize.bind(runtime.store);
	vi.spyOn(runtime.store, "authorize").mockImplementationOnce(async (...args) => {
		entered();
		await gate;
		return authorize(...args);
	});
	const invokeCreate = () =>
		attachment.invokeService(
			{ serviceId: SessionManagement.id, member: "create", args: [{}] },
			async () => {},
			context,
		);
	const admitted = invokeCreate();
	await started;
	const disposing = runtime.services.dispose();
	const late = invokeCreate();
	try {
		await expect(late).rejects.toThrow("Server services are disposed");
	} finally {
		release();
	}
	await expect(admitted).resolves.toMatchObject({ sessionId: expect.any(String) });
	await disposing;
});

test("shutdown waits for status commands as well as serialized mutations", async () => {
	const runtime = await fixture();
	const presentation = await runtime.gateway.open({ principal: alice, conversation, async send() {} });
	await presentation.execute("new", { type: "new" });
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const authorize = runtime.store.authorize.bind(runtime.store);
	vi.spyOn(runtime.store, "authorize").mockImplementationOnce(async (...args) => {
		entered();
		await gate;
		return authorize(...args);
	});
	const status = presentation.execute("status", { type: "status" }).catch((error: unknown) => error);
	await started;
	let closed = false;
	const closing = runtime.gateway.close().then(() => {
		closed = true;
	});
	try {
		await presentation.close();
		expect(closed).toBe(false);
	} finally {
		release();
	}
	await closing;
	expect(await status).toBeInstanceOf(Error);
});

test("verifies Discord signatures before resolving users and deduplicates signed interaction retries", async () => {
	const runtime = await fixture();
	const keys = generateKeyPairSync("ed25519");
	const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
	const resolvePrincipal = vi.fn(async () => alice);
	const replies: JsonValue[] = [];
	const adapter = new DiscordAdapter({
		applicationId: "99",
		publicKey,
		botToken: "test",
		resolvePrincipal,
		onError: (error) => {
			throw error;
		},
		fetch: async (_url, options) => {
			const body = JSON.parse(String(options?.body)) as JsonValue;
			replies.push(body);
			return Response.json({ id: "100" });
		},
	});
	await adapter.start(runtime.gateway);
	cleanup.push(() => adapter.stop());
	const body = JSON.stringify({
		id: "123",
		application_id: "99",
		type: 2,
		token: "secret",
		guild_id: "10",
		channel_id: "20",
		channel: { type: 11 },
		member: { user: { id: "30" } },
		data: { name: "punch", options: [{ name: "new" }] },
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex");
	const request = (signed: string) =>
		new Request("https://gateway.test/discord", {
			method: "POST",
			body,
			headers: { "x-signature-timestamp": timestamp, "x-signature-ed25519": signed },
		});
	expect((await adapter.handle(request("0".repeat(128)))).status).toBe(401);
	expect(resolvePrincipal).not.toHaveBeenCalled();
	expect(await (await adapter.handle(request(signature))).json()).toEqual({ type: 5, data: { flags: 64 } });
	await expect.poll(() => replies.length).toBe(1);
	const sessionId = runtime.store.conversation(alice, conversation);
	expect(sessionId).toBeTypeOf("string");
	await adapter.handle(request(signature));
	await expect.poll(() => replies.length).toBe(2);
	expect(runtime.store.conversation(alice, conversation)).toBe(sessionId);
	expect(replies[1]).toMatchObject({ content: expect.stringContaining('"duplicate":true') });
	expect(resolvePrincipal).toHaveBeenCalledWith(
		{ guildId: "10", channelId: "20", userId: "30" },
		expect.any(AbortSignal),
	);
});

test("streams Discord edits, reuses the final message and splits long replies without mentions", async () => {
	const runtime = await fixture();
	const keys = generateKeyPairSync("ed25519");
	const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
	const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
	const errors: unknown[] = [];
	let nextId = 100;
	const adapter = new DiscordAdapter({
		applicationId: "99",
		publicKey,
		botToken: "test",
		resolvePrincipal: async () => alice,
		onError: (error) => errors.push(error),
		fetch: async (url, options) => {
			requests.push({
				url: String(url),
				method: options?.method ?? "GET",
				body: JSON.parse(String(options?.body)) as Record<string, unknown>,
			});
			return Response.json({ id: String(nextId++) });
		},
	});
	await adapter.start(runtime.gateway);
	cleanup.push(() => adapter.stop());
	const body = JSON.stringify({
		id: "123",
		application_id: "99",
		type: 2,
		token: "secret",
		guild_id: "10",
		channel_id: "20",
		channel: { type: 11 },
		member: { user: { id: "30" } },
		data: { name: "punch", options: [{ name: "prompt", options: [{ name: "text", value: "hello" }] }] },
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex");
	await adapter.handle(
		new Request("https://gateway.test/discord", {
			method: "POST",
			body,
			headers: { "x-signature-timestamp": timestamp, "x-signature-ed25519": signature },
		}),
	);
	await expect.poll(() => runtime.prompt.mock.calls.length).toBe(1);
	const message = {
		role: "assistant" as const,
		api: "openai-completions" as const,
		provider: "test",
		model: "one",
		content: [{ type: "text" as const, text: "hello" }],
		usage: runtime.transcript.state.snapshot!.stats.usage,
		stopReason: "stop" as const,
		timestamp: 123,
	};
	runtime.transcript.state.snapshot!.operation!.streamingMessage = message;
	runtime.transcript.publish(BACKGROUND_CONTEXT);
	await expect.poll(() => requests.filter((request) => request.method === "POST").length, { timeout: 3000 }).toBe(1);
	const text = `@everyone ${"a".repeat(2100)}`;
	runtime.transcript.state.snapshot!.operation!.streamingMessage = undefined;
	runtime.transcript.state.snapshot!.transcript.push({
		type: "message",
		id: "final",
		parentId: null,
		seq: 1,
		timestamp: 456,
		message: { ...message, content: [{ type: "text", text }] },
	});
	runtime.transcript.publish(BACKGROUND_CONTEXT);
	const presentation = await runtime.gateway.open({ principal: alice, conversation, async send() {} });
	await presentation.execute("abort", { type: "abort" });
	await expect
		.poll(() => requests.some((request) => request.url.includes("/webhooks/")), { timeout: 5000 })
		.toBe(true);
	const messages = requests.filter((request) => request.url.includes("/channels/"));
	expect(messages.map((request) => request.method)).toEqual(["POST", "PATCH", "POST"]);
	expect(messages[1]!.url).toContain("/messages/100");
	expect(messages[1]!.body.content).toBe(text.slice(0, 2000));
	expect(messages[2]!.body.content).toBe(text.slice(2000));
	for (const request of messages) expect(request.body.allowed_mentions).toEqual({ parse: [] });
	expect(errors).toEqual([]);
});
