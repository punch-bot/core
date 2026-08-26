import { describe, expect, test } from "vitest";
import { createTextMessage, extractTextFromMessage } from "../src/message.ts";

describe("message helpers", () => {
	test("extractTextFromMessage joins text parts", () => {
		const message = createTextMessage("hello");
		const secondPart = {
			...message.parts[0],
			content: { $case: "text" as const, value: "world" },
		};
		const multiPartMessage = {
			...message,
			parts: [message.parts[0], secondPart],
		};
		expect(extractTextFromMessage(multiPartMessage)).toBe("hello\nworld");
	});
});
