import type { ProviderHeaders } from "../types.ts";

/**
 * `x-opencode-session` — OpenCode relay session-affinity header.
 *
 * OpenCode (opencode.ai Zen/Go/free relay) pins requests that share an
 * `x-opencode-session` value to the same upstream backend, which is what keeps
 * its prompt cache warm across the turns of one conversation. Without it the
 * relay cannot keep a conversation on one backend: cache ratios collapse and
 * some Go backends reject the request outright. The value only has to be opaque
 * and consistent per conversation, so it reuses the same per-conversation
 * session id already threaded through the transports for the OpenRouter /
 * xAI session-affinity hints.
 *
 * Every OpenCode request — main turn on any transport (chat-completions,
 * responses, anthropic-messages, google-generative-ai) — goes through
 * {@link opencodeSessionHeaders} so the header cannot drift per code path.
 * Non-OpenCode targets are left untouched.
 */

export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Built-in OpenCode relay provider families (Zen / Go; free rides on Zen keyless). */
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** True when *base_url* hosts the OpenCode relay: exactly `opencode.ai` or a subdomain of it. */
function isOpenCodeHost(baseUrl: string): boolean {
	const host = baseUrl
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // strip optional scheme
		.split("/")[0]
		.split("?")[0]
		.split("#")[0];
	return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/** True when *provider* or *base_url* addresses the OpenCode relay (Zen/Go/free/custom). */
export function isOpencodeTarget(provider: string | undefined, baseUrl: string | undefined): boolean {
	return (
		(provider !== undefined && OPENCODE_PROVIDERS.has(provider)) || (baseUrl !== undefined && isOpenCodeHost(baseUrl))
	);
}

/** Return `{ "x-opencode-session": sessionId }` for OpenCode targets, else `{}`. */
export function opencodeSessionHeaders(
	provider: string | undefined,
	baseUrl: string | undefined,
	sessionId: string | undefined,
): ProviderHeaders {
	if (!sessionId || !isOpencodeTarget(provider, baseUrl)) return {};
	return { [OPENCODE_SESSION_HEADER]: sessionId };
}
