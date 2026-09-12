import { describe, expect, test } from "vitest";
import { delegateToA2aAgent } from "../src/client.ts";
import { createA2aServer } from "../src/server.ts";

describe("A2A server and client", () => {
	test("delegates to a local A2A agent", async () => {
		const server = await createA2aServer({
			runnerFactory: () => ({
				async prompt(text) {
					return { text: `echo:${text}` };
				},
			}),
		});
		const bound = await server.listen(0, "127.0.0.1");
		try {
			const result = await delegateToA2aAgent({
				url: bound.url,
				task: "ping",
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
			});
			expect(result.failed).toBe(true);
			expect(result.error).toBe("boom");
			expect(result.text).toBe("boom");
		} finally {
			await server.close();
		}
	});
});
