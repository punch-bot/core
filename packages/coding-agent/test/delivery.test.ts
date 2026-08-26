import type { AgentMessage } from "@punch-bot/agent";
import { describe, expect, it } from "vitest";
import {
	buildEmbedFromJson,
	deliveryFromMessage,
	extractAttachments,
	extractEmbeds,
	extractQuestions,
	parseDelivery,
	parseQuestionAttrs,
	parseQuestionOptions,
	stripDiscordMarkup,
	textFromMessage,
} from "../src/core/delivery.ts";

describe("extractEmbeds", () => {
	it("parses an embed and strips the tag", () => {
		const { clean, embeds, errors } = extractEmbeds(
			'See this\n<embed>\n{"title":"Hello","description":"World","color":16711680}\n</embed>',
		);
		expect(clean).toBe("See this");
		expect(errors).toEqual([]);
		expect(embeds).toEqual([{ title: "Hello", description: "World", color: 16711680 }]);
	});

	it("reports malformed embed JSON as errors", () => {
		const { clean, embeds, errors } = extractEmbeds("<embed>{oops</embed>");
		expect(clean).toBe("");
		expect(embeds).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^embed JSON error:/);
	});

	it("caps embed field lengths", () => {
		const embed = buildEmbedFromJson({ title: "x".repeat(300), description: "y".repeat(5000) });
		expect(embed).not.toBeNull();
		expect(embed!.title!.length).toBe(256);
		expect(embed!.description!.length).toBe(4096);
	});

	it("ignores non-object embeds", () => {
		expect(buildEmbedFromJson(null)).toBeNull();
		expect(buildEmbedFromJson("nope")).toBeNull();
	});
});

describe("extractQuestions", () => {
	it("parses a question with markdown options and attrs", () => {
		const { clean, questions } = extractQuestions(
			'Pick one\n<question title="Which?" description="Pick" style="checkbox">\n- Alpha\n- Beta\n3. Gamma\n</question>',
		);
		expect(clean).toBe("Pick one");
		expect(questions).toEqual([
			{
				title: "Which?",
				description: "Pick",
				multi: false,
				style: "checkbox",
				input: [],
				options: ["Alpha", "Beta", "Gamma"],
			},
		]);
	});

	it("parses input options from the input attr", () => {
		const { questions } = extractQuestions('<question title="Q" input="a;b;c">\n- X\n</question>');
		expect(questions).toHaveLength(1);
		expect(questions[0].input).toEqual(["a", "b", "c"]);
		expect(questions[0].options).toEqual(["X"]);
	});

	it("drops questions without options or input", () => {
		const { clean, questions } = extractQuestions('<question title="Q">\nno options here\n</question>');
		expect(questions).toEqual([]);
		expect(clean).toBe("");
	});

	it("parses multi flag from unquoted attrs", () => {
		const attrs = parseQuestionAttrs('title="T" multi style="select"');
		expect(attrs.multi).toBe(true);
		expect(attrs.style).toBe("select");
	});

	it("parses question options from markdown list lines", () => {
		expect(parseQuestionOptions("- a\n* b\n• c\n1. d\nplain")).toEqual(["a", "b", "c", "d"]);
	});
});

describe("extractAttachments", () => {
	it("extracts path attr and self-closing form", () => {
		const { clean, attachments } = extractAttachments(
			'Here\n<attachment path="/work/out.png" />\n<attachment path="x/y.txt"></attachment>\n<attachment>/work/bare.txt</attachment>',
		);
		expect(clean).toBe("Here");
		expect(attachments).toEqual(["/work/out.png", "x/y.txt", "/work/bare.txt"]);
	});
});

describe("stripDiscordMarkup", () => {
	it("strips discord-only tags and collapses newlines", () => {
		expect(stripDiscordMarkup("text <react>foo</react> more\n\n\n\nend")).toBe("text  more\n\nend");
		expect(stripDiscordMarkup("a <forget /> b")).toBe("a  b");
	});
});

describe("textFromMessage", () => {
	it("returns string content directly", () => {
		expect(textFromMessage({ role: "assistant", content: "hello" } as unknown as AgentMessage)).toBe("hello");
	});

	it("joins text parts and skips non-text", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
				{ type: "text", text: "b" },
			],
		} as unknown as AgentMessage;
		expect(textFromMessage(msg)).toBe("ab");
	});
});

describe("parseDelivery / deliveryFromMessage", () => {
	it("parses a full message into a structured envelope", () => {
		const msg = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: 'Answer\n<embed>{"title":"T"}</embed>\n<question title="Q">\n- One\n- Two\n</question>\n<attachment path="/work/out.png" />',
				},
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
		} as unknown as AgentMessage;
		const delivery = deliveryFromMessage(msg);
		expect(delivery.text).toBe("Answer");
		expect(delivery.embeds).toEqual([{ title: "T" }]);
		expect(delivery.questions).toHaveLength(1);
		expect(delivery.questions[0].options).toEqual(["One", "Two"]);
		expect(delivery.attachments).toHaveLength(2);
		expect(delivery.attachments[0]).toMatchObject({
			path: "image-1.png",
			type: "image",
			data: "aGk=",
			mimeType: "image/png",
		});
		expect(delivery.attachments[1]).toEqual({ path: "/work/out.png" });
		expect(delivery.errors).toEqual([]);
	});

	it("parseDelivery works on a raw string", () => {
		const delivery = parseDelivery('<embed>{"description":"d"}</embed>text');
		expect(delivery.text).toBe("text");
		expect(delivery.embeds).toEqual([{ description: "d" }]);
	});
});
