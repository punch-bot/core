import type { IncomingMessage } from "node:http";
import type { Principal } from "@punch-bot/server";
import type { WebSocketIdentity } from "@punch-bot/server/websocket";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export interface OidcAuthenticatorOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly jwksUrl: string;
	readonly requiredScopes: readonly string[];
	/** Resolve verified issuer/subject to locally provisioned workspace membership and permissions. */
	resolvePrincipal(claims: JWTPayload, signal: AbortSignal): Promise<Principal>;
}

/** Validates access tokens obtained by Android's OIDC Authorization Code + PKCE flow. */
export function createOidcAuthenticator(
	options: OidcAuthenticatorOptions,
): (request: IncomingMessage, signal: AbortSignal) => Promise<WebSocketIdentity> {
	const url = new URL(options.jwksUrl);
	if (url.protocol !== "https:" || !options.issuer || !options.audience || options.requiredScopes.length === 0) {
		throw new TypeError("OIDC requires HTTPS JWKS, issuer, audience and required scopes");
	}
	const keys = createRemoteJWKSet(url, { timeoutDuration: 5_000 });
	return async (request, signal) => {
		signal.throwIfAborted();
		const authorization = request.headers.authorization ?? "";
		const scheme = /^Bearer[ \t]+/i.exec(authorization);
		if (!scheme || authorization.length > 16_384) throw new Error("Bearer token required");
		const { payload } = await jwtVerify(authorization.slice(scheme[0].length), keys, {
			issuer: options.issuer,
			audience: options.audience,
			algorithms: ["RS256", "ES256"],
			requiredClaims: ["sub", "iat", "exp"],
			maxTokenAge: "1h",
		});
		signal.throwIfAborted();
		const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
		if (payload.exp! - payload.iat! > 3600) throw new Error("Access token lifetime exceeds one hour");
		if (!options.requiredScopes.every((scope) => scopes.includes(scope)))
			throw new Error("Required access scope missing");
		const principal = await options.resolvePrincipal(payload, signal);
		signal.throwIfAborted();
		return { principal, expiresAt: payload.exp! * 1000 };
	};
}
