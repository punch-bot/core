import { formatUserAgent } from "@punch-bot/ai";

/** pi's detailed `User-Agent` for its own network requests. Provider requests send the short `punch-agent` form. */
export function getPiUserAgent(version: string): string {
	return formatUserAgent({ userAgent: "detailed", version });
}
