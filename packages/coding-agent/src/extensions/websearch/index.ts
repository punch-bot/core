import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8080";

export default function websearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "websearch",
		label: "Web search",
		description: "Search the web using a self-hosted SearXNG instance",
		promptSnippet: "Search the web for information",
		promptGuidelines: ["Use websearch for current information or references."],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
		}),
		async execute(_toolCallId, args) {
			const maxResults = args.maxResults || 5;
			const response = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(args.query)}&format=json`, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				throw new Error(`SearXNG returned ${response.status}: ${await response.text()}`);
			}
			const data = (await response.json()) as {
				results?: { title?: string; url?: string; content?: string }[];
			};
			const results = (data.results || []).slice(0, maxResults);
			const text = results.length
				? results
						.map((result, i) => {
							const content = result.content ? `\n   ${result.content}` : "";
							return `${i + 1}. **${result.title}**\n   ${result.url}${content}`;
						})
						.join("\n\n")
				: `No results found for: ${args.query}`;
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
}
