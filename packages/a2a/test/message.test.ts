import { describe, expect, test } from "vitest";
import { createTextMessage, extractTextFromMessage } from "../src/message.ts";

describe("message helpers", () => {
	test("extractTextFromMessage joins text parts", () => {
		const message = createTextMessage("hello");
		expect(extractTextFromMessage(message)).toBe("hello");
	});
});
