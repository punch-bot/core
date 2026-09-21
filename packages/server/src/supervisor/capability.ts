import { createHmac, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { getPrincipal, type Principal, withPrincipal } from "../principal.ts";

/** The trusted gateway signs a short-lived, generation-scoped copy of verified client identity. */
export function signRuntimeCapability(secret: string, generation: string, principal: Principal): string {
	const payload = Buffer.from(JSON.stringify({ generation, principal, expiresAt: Date.now() + 300_000 })).toString(
		"base64url",
	);
	return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyRuntimeCapability(
	token: string,
	secret: string,
	generation: string,
	workspaceId: string,
): { principal: Principal; expiresAt: number } {
	if (token.length > 16_384) throw new Error("Invalid runtime capability");
	const [payload, signature, extra] = token.split(".");
	if (!payload || !signature || extra !== undefined) throw new Error("Invalid runtime capability");
	const expected = createHmac("sha256", secret).update(payload).digest();
	const actual = Buffer.from(signature, "base64url");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error("Invalid runtime signature");
	const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
		generation: unknown;
		expiresAt: unknown;
		principal: Principal;
	};
	if (
		value.generation !== generation ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.expiresAt) ||
		value.expiresAt <= Date.now() ||
		value.expiresAt > Date.now() + 300_000
	)
		throw new Error("Expired or stale runtime capability");
	const principal = getPrincipal(withPrincipal(value.principal, BACKGROUND_CONTEXT))!;
	if (principal.workspaceId !== workspaceId) throw new Error("Runtime workspace mismatch");
	return { principal, expiresAt: value.expiresAt };
}
