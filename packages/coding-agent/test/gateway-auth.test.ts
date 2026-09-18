import { generateKeyPairSync } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { createOidcAuthenticator } from "../src/experimental/gateway/auth.ts";

afterEach(() => vi.unstubAllGlobals());

test("rejects blank required OIDC scopes", () => {
	expect(() =>
		createOidcAuthenticator({
			issuer: "https://identity.test",
			audience: "punch",
			jwksUrl: "https://identity.test/jwks",
			requiredScopes: [" "],
			resolvePrincipal: async () => ({ userId: "alice", workspaceId: "team", permissions: [] }),
		}),
	).toThrow("OIDC requires HTTPS JWKS, issuer, audience and required scopes");
});

test("validates OIDC signature, issuer, audience, expiry, lifetime and scopes before mapping identity", async () => {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" });
	const fetchKeys = vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "one", alg: "RS256", use: "sig" }] }));
	vi.stubGlobal("fetch", fetchKeys);
	const principal = { userId: "alice", workspaceId: "team", permissions: ["sessions:read"] };
	const resolvePrincipal = vi.fn(async () => principal);
	const authenticate = createOidcAuthenticator({
		issuer: "https://identity.test",
		audience: "punch",
		jwksUrl: "https://identity.test/jwks",
		requiredScopes: ["punch"],
		resolvePrincipal,
	});
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: "https://identity.test",
		aud: "punch",
		sub: "external-user",
		scope: "punch",
		iat: now,
		exp: now + 300,
	};
	const request = (token: string) => {
		const request = new IncomingMessage(new Socket());
		request.headers.authorization = `Bearer ${token}`;
		return request;
	};
	const token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "one" }).sign(privateKey);
	const signal = new AbortController().signal;
	await expect(authenticate(request(token), signal)).resolves.toEqual({ principal, expiresAt: claims.exp * 1000 });
	expect(resolvePrincipal).toHaveBeenCalledTimes(1);
	for (const invalid of [
		{ iss: "https://attacker.test" },
		{ aud: "other" },
		{ exp: now - 10 },
		{ exp: now + 7200 },
		{ scope: "other" },
		{ sub: undefined },
	]) {
		const token = await new SignJWT({ ...claims, ...invalid })
			.setProtectedHeader({ alg: "RS256", kid: "one" })
			.sign(privateKey);
		await expect(authenticate(request(token), signal)).rejects.toThrow();
	}
	const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	const forged = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "one" }).sign(otherKey);
	await expect(authenticate(request(forged), signal)).rejects.toThrow();
	expect(resolvePrincipal).toHaveBeenCalledTimes(1);
	expect(fetchKeys).toHaveBeenCalledTimes(1);
});
