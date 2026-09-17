import { type Context, createContextKey, withContextValue } from "@punch-bot/agent";

/** Verified application identity supplied by a trusted gateway adapter. */
export interface Principal {
	readonly userId: string;
	readonly workspaceId: string;
	readonly permissions: readonly string[];
}

const PRINCIPAL_CONTEXT_KEY = createContextKey<Principal>("punch.principal");

/** Missing identity grants no permissions. Service hosts must enforce access. */
export function getPrincipal(context: Context): Principal | undefined {
	return context.value(PRINCIPAL_CONTEXT_KEY);
}

/** Snapshot verified claims so adapter mutations cannot change an accepted identity. */
export function withPrincipal(principal: Principal, context: Context): Context {
	if (
		typeof principal.userId !== "string" ||
		!principal.userId.trim() ||
		typeof principal.workspaceId !== "string" ||
		!principal.workspaceId.trim() ||
		!Array.isArray(principal.permissions) ||
		principal.permissions.some((permission) => typeof permission !== "string" || !permission)
	) {
		throw new TypeError("Invalid authenticated principal");
	}
	const snapshot: Principal = Object.freeze({
		userId: principal.userId,
		workspaceId: principal.workspaceId,
		permissions: Object.freeze([...principal.permissions]),
	});
	return withContextValue(PRINCIPAL_CONTEXT_KEY, snapshot, context);
}
