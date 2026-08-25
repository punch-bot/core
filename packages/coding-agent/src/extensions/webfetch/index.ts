import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "typebox";
import { Agent, request } from "undici";
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

function expandIpv6(address: string): string {
	const withoutZone = address.split("%")[0];
	if (!withoutZone.includes("::")) return withoutZone;
	const [head, tail] = withoutZone.split("::");
	const headParts = head ? head.split(":") : [];
	const tailParts = tail ? tail.split(":") : [];
	const missing = Math.max(0, 8 - headParts.length - tailParts.length);
	return [...headParts, ...Array(missing).fill("0"), ...tailParts].join(":");
}

function isBlockedIp(ip: string): boolean {
	const v = ip.toLowerCase();
	if (v === "::1" || v === "::" || v === "0.0.0.0") return true;
	if (v.startsWith("::ffff:")) return isBlockedIp(v.slice(7));
	if (v.includes(":")) {
		const first = Number.parseInt(expandIpv6(v).split(":")[0], 16);
		if (Number.isNaN(first)) return false;
		if (first >= 0xfc00 && first <= 0xfdff) return true;
		if (first >= 0xfe80 && first <= 0xfebf) return true;
		return false;
	}
	if (/^127\./.test(v) || /^169\.254\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v)) return true;
	return /^172\.(1[6-9]|2\d|3[01])\./.test(v);
}

interface SafeTarget {
	url: URL;
	hostname: string;
	addresses: string[];
}

async function resolveSafe(value: string): Promise<SafeTarget> {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http and https URLs are supported");
	}
	let hostname = parsed.hostname.toLowerCase();
	if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
	if (hostname === "localhost") {
		throw new Error("URLs pointing at loopback addresses are not allowed");
	}
	let addresses: string[];
	const literalFamily = isIP(hostname);
	if (literalFamily !== 0) {
		addresses = [hostname];
	} else {
		try {
			addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address);
		} catch {
			throw new Error(`Could not resolve host: ${hostname}`);
		}
	}
	for (const address of addresses) {
		if (isBlockedIp(address)) {
			throw new Error("URLs pointing at loopback, private, or link-local addresses are not allowed");
		}
	}
	return { url: parsed, hostname, addresses };
}

function pinnedAgent(target: SafeTarget): Agent {
	return new Agent({
		connect: {
			lookup: (
				host: string,
				options: LookupOptions,
				callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
			) => {
				if (host !== target.hostname) {
					callback(new Error(`unexpected host ${host}`), []);
					return;
				}
				const entries: LookupAddress[] = target.addresses.map((address) => ({
					address,
					family: isIP(address) === 6 ? 6 : 4,
				}));
				if (options.all) {
					callback(null, entries);
					return;
				}
				const first = entries[0];
				callback(null, first.address, first.family);
			},
		},
	});
}

const MAX_REDIRECTS = 5;

async function fetchText(url: string, rawLimit: number): Promise<{ text: string; contentType: string }> {
	let current = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const target = await resolveSafe(current);
		const agent = pinnedAgent(target);
		let statusCode: number;
		let headers: Record<string, string | string[] | undefined>;
		let stream: NodeJS.ReadableStream;
		try {
			const res = await request(target.url.toString(), {
				dispatcher: agent,
				method: "GET",
				signal: AbortSignal.timeout(15_000),
			});
			statusCode = res.statusCode;
			headers = res.headers;
			stream = res.body;
		} finally {
			void agent.close();
		}
		const location = headers.location;
		if (statusCode >= 300 && statusCode < 400) {
			if (!location) throw new Error(`HTTP ${statusCode} with no redirect location`);
			if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
			current = new URL(location, target.url).toString();
			continue;
		}
		if (statusCode < 200 || statusCode >= 300) throw new Error(`HTTP ${statusCode}`);
		const contentType = String(headers["content-type"] ?? "");
		const decoder = new TextDecoder();
		let text = "";
		for await (const chunk of stream) {
			text += decoder.decode(chunk as Uint8Array, { stream: true });
			if (text.length >= rawLimit) break;
		}
		return { text, contentType };
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
			const rawLimit = Math.min(Math.max(maxChars * 8, 64 * 1024), 4 * 1024 * 1024);
			try {
				const { text, contentType } = await fetchText(url, rawLimit);
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
							await resolveSafe(reqUrl);
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
