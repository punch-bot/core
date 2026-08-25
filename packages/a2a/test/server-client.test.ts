import { describe, expect, test } from "vitest";
import { delegateToA2aAgent } from "../src/client.ts";
import { createA2aServer } from "../src/server.ts";

describe("A2A server and client", () => {
	test("delegates to a local A2A agent", async () => {
		const port = 41241;
		const baseUrl = `http://127.0.0.1:${port}`;
		const server = await createA2aServer({
			baseUrl,
			runnerFactory: () => ({
				async prompt(text) {
					return { text: `echo:${text}` };
				},
			}),
		});
		await server.listen(port);
		try {
			const result = await delegateToA2aAgent({
				url: baseUrl,
				task: "ping",
			});
			expect(result.text).toBe("echo:ping");
		} finally {
			await server.close();
		}
	});
});
