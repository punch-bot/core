import { lookup } from "node:dns/promises";
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

function isBlockedIp(ip: string): boolean {
	const v = ip.toLowerCase();
	if (v === "::1" || v === "::" || v === "0.0.0.0") return true;
	if (v.startsWith("::ffff:")) return isBlockedIp(v.slice(7));
	if (v.startsWith("fc") || v.startsWith("fd")) return true;
	if (v.startsWith("fe80")) return true;
	if (/^127\./.test(v) || /^169\.254\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v)) return true;
	return /^172\.(1[6-9]|2\d|3[01])\./.test(v);
}

async function assertSafeWebUrl(value: string): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http and https URLs are supported");
	}
	const hostname = parsed.hostname.toLowerCase();
	if (hostname === "localhost") {
		throw new Error("URLs pointing at loopback addresses are not allowed");
	}
	let addresses: string[];
	try {
		addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address);
	} catch {
		throw new Error(`Could not resolve host: ${hostname}`);
	}
	for (const address of addresses) {
		if (isBlockedIp(address)) {
			throw new Error("URLs pointing at loopback, private, or link-local addresses are not allowed");
		}
	}
	return parsed;
}

const MAX_REDIRECTS = 5;

async function fetchText(url: string, maxChars: number): Promise<{ text: string; contentType: string }> {
	let current = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const target = await assertSafeWebUrl(current);
		const res = await fetch(target.toString(), { signal: AbortSignal.timeout(15_000), redirect: "manual" });
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`HTTP ${res.status} with no redirect location`);
			if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
			current = new URL(location, target).toString();
			continue;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const contentType = res.headers.get("content-type") || "";
		const reader = res.body?.getReader();
		if (!reader) return { text: "", contentType };
		const decoder = new TextDecoder();
		let body = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			body += decoder.decode(value, { stream: true });
			if (body.length >= maxChars) break;
		}
		await reader.cancel().catch(() => {});
		return { text: body, contentType };
	}
	throw new Error("Too many redirects");
}

export default function webfetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "webfetch",
		label: "Fetch web page",
		description: "Fetch a URL and return readable text content",
		promptSnippet: "Fetch and read a web page",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxChars: Type.Optional(Type.Number({ minimum: 1, description: "Maximum characters" })),
		}),
		async execute(_toolCallId, args) {
			const url = String(args.url);
			const maxChars = Math.max(1, Math.floor(Number(args.maxChars) || 15000));
			try {
				const { text, contentType } = await fetchText(url, maxChars);
				const clean = contentType.includes("text/html") ? stripHtml(text) : text;
				return { content: [{ type: "text" as const, text: clean.slice(0, maxChars) }], details: {} };
			} catch (err) {
				const message = (err as Error).message;
				const browser = (globalThis as { __pi_browser?: unknown }).__pi_browser;
				if (!browser) {
					throw new Error(`Could not fetch ${url}. No browser available and fetch failed: ${message}`);
				}
				const page = await (browser as { newPage(): Promise<unknown> }).newPage();
				try {
					const guarded = page as {
						route(pattern: string, handler: (route: unknown) => Promise<void>): Promise<void>;
						goto(url: string, opts: unknown): Promise<unknown>;
						evaluate(fn: string, max: number): Promise<string>;
						close(): Promise<void>;
					};
					await guarded.route("**/*", async (route) => {
						const reqUrl = (route as { request(): { url(): string } }).request().url();
						try {
							await assertSafeWebUrl(reqUrl);
							await (route as { continue(): Promise<void> }).continue();
						} catch {
							await (route as { abort(): Promise<void> }).abort();
						}
					});
					await guarded.goto(url, {
						waitUntil: "domcontentloaded",
						timeout: 30_000,
					});
					await new Promise((resolve) => setTimeout(resolve, 2_000));
					const text = await guarded.evaluate(
						"(max) => { const el = document.querySelector(\"article, main, [role='main'], .content, #content\") || document.body; return el?.innerText?.slice(0, max) || document.title; }",
						maxChars,
					);
					return { content: [{ type: "text" as const, text }], details: {} };
				} finally {
					await (page as { close(): Promise<void> }).close();
				}
			}
		},
	});
}
