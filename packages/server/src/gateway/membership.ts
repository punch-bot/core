import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "@punch-bot/agent";
import { getPrincipal, type Principal, withPrincipal } from "../principal.ts";

interface Membership {
	principal: Principal;
	oidcSubject?: string;
	discord?: { guildId: string; channelId: string; userId: string };
}

/** Explicit issuer-subject and Discord thread grants. Reload on each authorization to observe revocations. */
export function createFileMembership(path: string) {
	const load = async (): Promise<Membership[]> => {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(value)) throw new Error("Membership configuration must be an array");
		return value.map((entry: unknown) => {
			if (!entry || typeof entry !== "object" || !("principal" in entry)) throw new Error("Invalid membership");
			const principal = getPrincipal(withPrincipal(entry.principal as Principal, BACKGROUND_CONTEXT))!;
			let oidcSubject: string | undefined;
			if ("oidcSubject" in entry) {
				if (typeof entry.oidcSubject !== "string" || !entry.oidcSubject) throw new Error("Invalid OIDC subject");
				oidcSubject = entry.oidcSubject;
			}
			let discord: Membership["discord"];
			if ("discord" in entry) {
				const value = entry.discord;
				if (
					!value ||
					typeof value !== "object" ||
					!("guildId" in value) ||
					!("channelId" in value) ||
					!("userId" in value) ||
					![value.guildId, value.channelId, value.userId].every(
						(id) => typeof id === "string" && /^\d{1,20}$/.test(id),
					)
				)
					throw new Error("Invalid Discord membership");
				discord = value as NonNullable<Membership["discord"]>;
			}
			if (!oidcSubject && !discord) throw new Error("Membership has no external identity");
			return { principal, oidcSubject, discord };
		});
	};
	return {
		async oidc(subject: string): Promise<Principal> {
			const matches = (await load()).filter((entry) => entry.oidcSubject === subject);
			if (matches.length !== 1) throw new Error("OIDC membership missing or ambiguous");
			return { ...matches[0]!.principal, externalIdentity: { type: "oidc", subject } };
		},
		async discord(identity: NonNullable<Membership["discord"]>): Promise<Principal> {
			const matches = (await load()).filter(
				(entry) =>
					entry.discord?.guildId === identity.guildId &&
					entry.discord.channelId === identity.channelId &&
					entry.discord.userId === identity.userId,
			);
			if (matches.length !== 1) throw new Error("Discord thread membership missing or ambiguous");
			return { ...matches[0]!.principal, externalIdentity: { type: "discord", ...identity } };
		},
		async authorize(context: Context): Promise<void> {
			const principal = getPrincipal(context);
			const identity = principal?.externalIdentity;
			const matches = (await load()).filter((entry) =>
				identity?.type === "oidc"
					? entry.oidcSubject === identity.subject
					: identity?.type === "discord" &&
						entry.discord?.guildId === identity.guildId &&
						entry.discord.channelId === identity.channelId &&
						entry.discord.userId === identity.userId,
			);
			if (
				!principal ||
				matches.length !== 1 ||
				matches[0]!.principal.userId !== principal.userId ||
				matches[0]!.principal.workspaceId !== principal.workspaceId ||
				!principal.permissions.every((permission) => matches[0]!.principal.permissions.includes(permission))
			)
				throw new Error("Workspace membership revoked; reconnect");
		},
	};
}
