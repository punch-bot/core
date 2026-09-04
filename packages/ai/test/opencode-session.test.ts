import { describe, expect, it } from "vitest";
import { isOpencodeTarget, OPENCODE_SESSION_HEADER, opencodeSessionHeaders } from "../src/api/opencode-session.ts";

describe("isOpencodeTarget", () => {
	it.each([
		["zen provider", "opencode", undefined, true],
		["go provider", "opencode-go", undefined, true],
		["zen base_url", undefined, "https://opencode.ai", true],
		["subdomain base_url", undefined, "https://api.opencode.ai/v1", true],
		["custom provider on opencode.ai", "my-custom", "https://opencode.ai", true],
		["path includes opencode.ai", undefined, "https://example.com/opencode.ai/relay", false],
		["lookalike host suffix", undefined, "https://opencode.ai.attacker.example", false],
		["opencode.go json host (negative)", undefined, "https://opencode.go/api", false],
	] as const)("%s -> %j", (_label, provider, baseUrl, expected) => {
		expect(isOpencodeTarget(provider, baseUrl)).toBe(expected);
	});

	it("rejects non-OpenCode providers and hosts", () => {
		expect(isOpencodeTarget("openai", "https://api.openai.com")).toBe(false);
		expect(isOpencodeTarget("openrouter", "https://openrouter.ai")).toBe(false);
		expect(isOpencodeTarget(undefined, undefined)).toBe(false);
	});
});

describe("opencodeSessionHeaders", () => {
	it("emits x-opencode-session for OpenCode providers when a session id exists", () => {
		expect(opencodeSessionHeaders("opencode", "https://opencode.ai", "conv-123")).toEqual({
			[OPENCODE_SESSION_HEADER]: "conv-123",
		});
		expect(opencodeSessionHeaders("opencode-go", undefined, "conv-123")).toEqual({
			[OPENCODE_SESSION_HEADER]: "conv-123",
		});
	});

	it("emits the header for custom providers pointing at the opencode.ai host", () => {
		expect(opencodeSessionHeaders("custom", "https://opencode.ai", "conv-123")).toEqual({
			[OPENCODE_SESSION_HEADER]: "conv-123",
		});
	});

	it("returns {} without a session id even for OpenCode targets", () => {
		expect(opencodeSessionHeaders("opencode", "https://opencode.ai", undefined)).toEqual({});
		expect(opencodeSessionHeaders("opencode", "https://opencode.ai", "")).toEqual({});
	});

	it("returns {} for non-OpenCode targets even with a session id", () => {
		expect(opencodeSessionHeaders("openai", "https://api.openai.com", "conv-123")).toEqual({});
		expect(opencodeSessionHeaders(undefined, undefined, "conv-123")).toEqual({});
	});
});
