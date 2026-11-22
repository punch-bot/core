import { describe, expect, it } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";

describe("catalog thinking-off capabilities", () => {
	it.each([
		["opencode-go", "deepseek-v4.1-flash", true],
		["moonshotai", "kimi-k2.7-code", false],
	] as const)("serializes supported thinking off for %s/%s", async (provider, id, supportsOff) => {
		const model = getModels(provider).find((candidate) => candidate.id === id)!;
		expect(model.thinkingLevelMap?.off !== null).toBe(supportsOff);
		let payload: { thinking?: unknown } | undefined;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			payload = JSON.parse(String(init?.body)) as { thinking?: unknown };
			return new Response(
				`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
			{
				apiKey: "test",
				sessionId: "test-session",
				fetch,
				reasoning: undefined,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(payload).toBeDefined();
		if (supportsOff) expect(payload?.thinking).toEqual({ type: "disabled" });
		else expect(payload).not.toHaveProperty("thinking");
	});
});
