import { type Context, createContextKey, withContextValue } from "@punch-bot/agent";

/** Verified application identity supplied by a trusted gateway adapter. */
export interface Principal {
	readonly userId: string;
	readonly workspaceId: string;
	readonly permissions: readonly string[];
	/** Credential that established this principal, retained for membership reauthorization. */
	readonly externalIdentity?:
		| { readonly type: "oidc"; readonly subject: string }
		| { readonly type: "discord"; readonly guildId: string; readonly channelId: string; readonly userId: string };
}

const PRINCIPAL_CONTEXT_KEY = createContextKey<Principal>("punch.principal");

/** Missing identity grants no permissions. Service hosts must enforce access. */
export function getPrincipal(context: Context): Principal | undefined {
	return context.value(PRINCIPAL_CONTEXT_KEY);
}

/** Snapshot verified claims so adapter mutations cannot change an accepted identity. */
export function withPrincipal(principal: Principal, context: Context): Context {
	const identity = principal.externalIdentity;
	const validIdentity =
		identity === undefined ||
		(identity !== null &&
			typeof identity === "object" &&
			(identity.type === "oidc"
				? typeof identity.subject === "string" && !!identity.subject.trim()
				: identity.type === "discord" &&
					[identity.guildId, identity.channelId, identity.userId].every(
						(value) => typeof value === "string" && !!value.trim(),
					)));
	if (
		typeof principal.userId !== "string" ||
		!principal.userId.trim() ||
		typeof principal.workspaceId !== "string" ||
		!principal.workspaceId.trim() ||
		!Array.isArray(principal.permissions) ||
		principal.permissions.some((permission) => typeof permission !== "string" || !permission) ||
		!validIdentity
	) {
		throw new TypeError("Invalid authenticated principal");
	}
	const snapshot: Principal = Object.freeze({
		userId: principal.userId,
		workspaceId: principal.workspaceId,
		permissions: Object.freeze([...principal.permissions]),
		...(principal.externalIdentity ? { externalIdentity: Object.freeze({ ...principal.externalIdentity }) } : {}),
	});
	return withContextValue(PRINCIPAL_CONTEXT_KEY, snapshot, context);
}
