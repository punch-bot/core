import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { RemoteServiceError } from "@punch-bot/chord";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { Client } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { getPrincipal, Server, type ServerHost } from "../src/index.ts";
import { TestServerHost } from "../src/testing/host.ts";
import { createWebSocketListener } from "../src/websocket.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
});

async function setup(options: { expiresIn?: number; maxFrameLength?: number; authenticateDelay?: Promise<void> } = {}) {
	const http = createServer();
	const fixture = new TestServerHost();
	await fixture.seed("one");
	const principals: string[] = [];
	const host: ServerHost = {
		serverServices: fixture.serverServices,
		resolveSession: (id, context) => fixture.resolveSession(id, context),
		openSession: (metadata, context) => fixture.openSession(metadata, context),
		authorizeSession(id, _call, context) {
			const principal = getPrincipal(context);
			principals.push(principal?.userId ?? "missing");
			if (principal?.userId !== "alice" || id !== "one")
				throw new RemoteServiceError("service_not_allowed", "Denied");
		},
	};
	const authenticate = vi.fn(async (request: IncomingMessage) => {
		await options.authenticateDelay;
		const userId = request.headers.authorization?.slice(7);
		if (userId !== "alice" && userId !== "bob") throw new Error("Unauthorized");
		return {
			principal: { userId, workspaceId: userId, permissions: ["sessions:read"] },
			expiresAt: Date.now() + (options.expiresIn ?? 60_000),
		};
	});
	const listener = createWebSocketListener({ server: http, authenticate, maxFrameLength: options.maxFrameLength });
	const server = new Server(host, { serverId: "00000000-0000-4000-8000-000000000001", listeners: [listener] });
	await server.start();
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	cleanups.push(async () => {
		await server.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await fixture.repo.close(BACKGROUND_CONTEXT);
	});
	const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/punch`;
	const connect = async (token = "alice") => {
		const client = await Client.connect({
			serverId: server.serverId,
			transportFactory: createWebSocketTransportFactory({ url, getAccessToken: async () => token }),
		});
		cleanups.push(() => client.dispose());
		return client;
	};
	return { server, fixture, principals, authenticate, listener, url, connect };
}

test("routes authenticated bytes and checks cached sessions for each principal", async () => {
	const { server, fixture, principals, connect } = await setup();
	const alice = await connect();
	const attach = { serviceId: "pi.session-management", member: "attach", args: ["one"] };
	await alice.request({ serverId: server.serverId }, attach);
	await alice.request(alice.attachment!, { serviceId: "test", member: "read", args: [] });
	const bob = await connect("bob");
	await expect(bob.request({ serverId: server.serverId }, attach)).rejects.toMatchObject({
		code: "service_not_allowed",
	});
	expect(fixture.openSessionCount).toBe(1);
	expect(principals).toEqual(["alice", "alice", "bob"]);
	expect(bob.attachment).toBeUndefined();
});

test("rejects invalid authentication before creating a protocol connection", async () => {
	const { connect, fixture } = await setup();
	await expect(connect("invalid")).rejects.toThrow();
	expect(fixture.openSessionCount).toBe(0);
});

test("reauthenticates on reconnect and clears the attachment", async () => {
	const { connect, authenticate, server } = await setup({ expiresIn: 500 });
	const client = await connect();
	await client.request(
		{ serverId: server.serverId },
		{ serviceId: "pi.session-management", member: "attach", args: ["one"] },
	);
	await expect.poll(() => client.connected, { timeout: 3_000 }).toBe(false);
	await client.reconnect();
	expect(client.attachment).toBeUndefined();
	expect(authenticate).toHaveBeenCalledTimes(2);
});

test("closes established connections when their access token expires", async () => {
	const { connect } = await setup({ expiresIn: 150 });
	const client = await connect();
	await expect.poll(() => client.connected).toBe(false);
});

test.each(["text", "oversized"])("rejects %s WebSocket messages", async (kind) => {
	const { url } = await setup({ maxFrameLength: 1024 });
	const socket = new WebSocket(url, { headers: { Authorization: "Bearer alice" } });
	await once(socket, "open");
	const closed = once(socket, "close");
	socket.send(kind === "text" ? "hello" : new Uint8Array(1029));
	const [code] = await closed;
	expect(code).toBe(kind === "text" ? 1003 : 1009);
});

test("bounds output before queueing it", async () => {
	const { url } = await setup();
	const errors: Error[] = [];
	const factory = createWebSocketTransportFactory({
		url,
		getAccessToken: async () => "alice",
		maxFrameLength: 64,
		maxPendingBytes: 68,
	});
	const transport = await factory({ onData() {}, onClose() {}, onError: (error) => errors.push(error) });
	await expect(transport.send(new Uint8Array(69))).rejects.toThrow("pending byte limit");
	transport.close();
	expect(errors).toEqual([]);
});

test("shutdown aborts pending authentication without accepting late results", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { connect, authenticate, listener, fixture } = await setup({ authenticateDelay: gate });
	const connecting = connect().catch(() => undefined);
	await expect.poll(() => authenticate.mock.calls.length).toBe(1);
	await listener.close();
	release();
	expect(await connecting).toBeUndefined();
	expect(fixture.openSessionCount).toBe(0);
});
