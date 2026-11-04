import { request } from "node:http";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { describe, expect, test } from "vitest";
import { delegateToA2aAgent } from "../src/client.ts";
import { createA2aServer } from "../src/server.ts";

function echoServer(authToken?: string) {
	return createA2aServer({
		authToken,
		runnerFactory: () => ({
			async prompt(text) {
				return { text: `echo:${text}` };
			},
		}),
	});
}

const sendBody = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "SendMessage",
	params: {
		message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "run something" }] },
	},
});

function postRaw(port: number, headers: Record<string, string>, path = "/"): Promise<number> {
	const method = path === "/" ? "POST" : "GET";
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end(method === "POST" ? sendBody : undefined);
	});
}

describe("A2A server and client", () => {
	test("delegates to a local A2A agent", async () => {
		const server = await echoServer();
		const bound = await server.listen(0, "127.0.0.1");
		try {
			const result = await delegateToA2aAgent({
				url: bound.url,
				task: "ping",
				token: server.authToken,
			});
			expect(result.text).toBe("echo:ping");
			expect(result.failed).toBeUndefined();
		} finally {
			await server.close();
		}
	});

	test("surfaces harness failures to callers", async () => {
		const server = await createA2aServer({
			runnerFactory: () => ({
				async prompt() {
					return { message: "boom" };
				},
			}),
		});
		const bound = await server.listen(0, "127.0.0.1");
		try {
			const result = await delegateToA2aAgent({
				url: bound.url,
				task: "fail",
				token: server.authToken,
			});
			expect(result.failed).toBe(true);
			expect(result.error).toBe("boom");
			expect(result.text).toBe("boom");
		} finally {
			await server.close();
		}
	});

	test("generates a random token per server", async () => {
		const a = await echoServer();
		const b = await echoServer();
		expect(a.authToken.length).toBeGreaterThanOrEqual(32);
		expect(a.authToken).not.toBe(b.authToken);
	});

	test("rejects clients without the token", async () => {
		const server = await echoServer("secret-token");
		const bound = await server.listen(0, "127.0.0.1");
		try {
			await expect(delegateToA2aAgent({ url: bound.url, task: "ping" })).rejects.toThrow();
			await expect(delegateToA2aAgent({ url: bound.url, task: "ping", token: "wrong" })).rejects.toThrow();
		} finally {
			await server.close();
		}
	});

	test("rejects message/send without a valid bearer token", async () => {
		const server = await echoServer("secret-token");
		const bound = await server.listen(0, "127.0.0.1");
		const host = `127.0.0.1:${bound.port}`;
		try {
			expect(await postRaw(bound.port, { host })).toBe(401);
			expect(await postRaw(bound.port, { host, authorization: "Bearer wrong" })).toBe(401);
			expect(await postRaw(bound.port, { host, authorization: "Basic secret-token" })).toBe(401);
			expect(await postRaw(bound.port, { host }, `/${AGENT_CARD_PATH}`)).toBe(401);
			expect(await postRaw(bound.port, { host, authorization: "Bearer secret-token" }, `/${AGENT_CARD_PATH}`)).toBe(
				200,
			);
		} finally {
			await server.close();
		}
	});

	test("rejects requests with a foreign Host header", async () => {
		const server = await echoServer("secret-token");
		const bound = await server.listen(0, "127.0.0.1");
		try {
			const authorization = "Bearer secret-token";
			expect(await postRaw(bound.port, { host: "evil.example", authorization })).toBe(403);
			expect(await postRaw(bound.port, { host: `evil.example:${bound.port}`, authorization })).toBe(403);
			expect(await postRaw(bound.port, { host: "evil.example", authorization }, `/${AGENT_CARD_PATH}`)).toBe(403);
			expect(
				await postRaw(bound.port, { host: `localhost:${bound.port}`, authorization }, `/${AGENT_CARD_PATH}`),
			).toBe(200);
		} finally {
			await server.close();
		}
	});

	test("rejects an empty token", async () => {
		await expect(echoServer("  ")).rejects.toThrow("must not be empty");
	});
});
