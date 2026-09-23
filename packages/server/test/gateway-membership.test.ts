import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { expect, test } from "vitest";
import { createFileMembership } from "../src/gateway/membership.ts";
import { type Principal, withPrincipal } from "../src/principal.ts";

test("file memberships isolate Discord threads and reject cached identities after revocation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-membership-"));
	const path = join(directory, "memberships.json");
	const principal = { userId: "alice", workspaceId: "team", permissions: ["sessions:read", "sessions:control"] };
	const discord = { guildId: "1", channelId: "2", userId: "3" };
	const grant = { principal, oidcSubject: "issuer-alice", discord };
	try {
		await writeFile(path, JSON.stringify([grant]));
		const membership = createFileMembership(path);
		const oidcPrincipal = await membership.oidc("issuer-alice");
		expect(oidcPrincipal).toEqual({ ...principal, externalIdentity: { type: "oidc", subject: "issuer-alice" } });
		expect(await membership.discord(discord)).toEqual({
			...principal,
			externalIdentity: { type: "discord", ...discord },
		});
		for (const field of ["guildId", "channelId", "userId"]) {
			await expect(membership.discord({ ...discord, [field]: "4" })).rejects.toThrow("membership missing");
		}
		const context = withPrincipal(oidcPrincipal, BACKGROUND_CONTEXT);
		await membership.authorize(context);
		await writeFile(
			path,
			JSON.stringify([{ ...grant, principal: { ...principal, permissions: ["sessions:read"] } }]),
		);
		await expect(membership.authorize(context)).rejects.toThrow("revoked");
		await writeFile(path, JSON.stringify([grant, grant]));
		await expect(membership.oidc("issuer-alice")).rejects.toThrow("ambiguous");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("revokes only the removed external credential even when another grant has the same principal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-membership-"));
	const path = join(directory, "memberships.json");
	const principal = { userId: "alice", workspaceId: "team", permissions: ["sessions:read"] };
	const discord = { guildId: "1", channelId: "2", userId: "3" };
	const grants = [
		{ principal, oidcSubject: "alice" },
		{ principal, discord },
	];
	try {
		await writeFile(path, JSON.stringify(grants));
		const membership = createFileMembership(path);
		const oidcContext = withPrincipal(await membership.oidc("alice"), BACKGROUND_CONTEXT);
		const discordContext = withPrincipal(await membership.discord(discord), BACKGROUND_CONTEXT);
		await membership.authorize(oidcContext);
		await membership.authorize(discordContext);
		await writeFile(path, JSON.stringify([grants[1]]));
		await expect(membership.authorize(oidcContext)).rejects.toThrow("revoked");
		await membership.authorize(discordContext);
		await writeFile(path, JSON.stringify([grants[0]]));
		await membership.authorize(oidcContext);
		await expect(membership.authorize(discordContext)).rejects.toThrow("revoked");
		await writeFile(path, JSON.stringify([grants[0], grants[0]]));
		await expect(membership.authorize(oidcContext)).rejects.toThrow("revoked");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed external identities at the principal boundary", () => {
	const principal = { userId: "alice", workspaceId: "team", permissions: ["sessions:read"] };
	for (const externalIdentity of [
		{ type: "oidc" },
		{ type: "unknown", subject: "alice" },
		{ type: "discord", guildId: "1", channelId: "2" },
		{ type: "discord", guildId: "1", channelId: " ", userId: "3" },
	]) {
		expect(() => withPrincipal({ ...principal, externalIdentity } as Principal, BACKGROUND_CONTEXT)).toThrow(
			"Invalid authenticated principal",
		);
	}
});
