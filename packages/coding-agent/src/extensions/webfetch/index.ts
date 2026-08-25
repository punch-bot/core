import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export default function webfetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "webfetch",
		label: "Fetch web page",
		description: "Fetch a URL and return readable text content",
		promptSnippet: "Fetch and read a web page",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxChars: Type.Optional(Type.Number({ description: "Maximum characters" })),
		}),
		async execute(_toolCallId, args) {
			const url = String(args.url);
			const maxChars = Number(args.maxChars) || 15000;
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const contentType = res.headers.get("content-type") || "";
				const text = contentType.includes("text/html") ? stripHtml(await res.text()) : await res.text();
				if (text.length >= 50) {
					return { content: [{ type: "text" as const, text: text.slice(0, maxChars) }], details: {} };
				}
			} catch {
				// JS-rendered pages use the browser fallback below.
			}
			const browser = (globalThis as { __pi_browser?: unknown }).__pi_browser;
			if (!browser) {
				throw new Error(`Could not fetch ${url}. No browser available and fetch failed.`);
			}
			const page = await (browser as { newPage(): Promise<unknown> }).newPage();
			try {
				await (page as { goto(url: string, opts: unknown): Promise<unknown> }).goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				const text = await (page as { evaluate(fn: string, max: number): Promise<string> }).evaluate(
					"(max) => { const el = document.querySelector(\"article, main, [role='main'], .content, #content\") || document.body; return el?.innerText?.slice(0, max) || document.title; }",
					maxChars,
				);
				return { content: [{ type: "text" as const, text }], details: {} };
			} finally {
				await (page as { close(): Promise<void> }).close();
			}
		},
	});
}
