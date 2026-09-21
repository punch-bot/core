import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { expect, test } from "vitest";
import { createFileMembership } from "../src/gateway/membership.ts";
import { withPrincipal } from "../src/principal.ts";

test("file memberships isolate Discord threads and reject cached identities after revocation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-membership-"));
	const path = join(directory, "memberships.json");
	const principal = { userId: "alice", workspaceId: "team", permissions: ["sessions:read", "sessions:control"] };
	const discord = { guildId: "1", channelId: "2", userId: "3" };
	const grant = { principal, oidcSubject: "issuer-alice", discord };
	try {
		await writeFile(path, JSON.stringify([grant]));
		const membership = createFileMembership(path);
		expect(await membership.oidc("issuer-alice")).toEqual(principal);
		expect(await membership.discord(discord)).toEqual(principal);
		await expect(membership.discord({ ...discord, channelId: "4" })).rejects.toThrow("membership missing");
		const context = withPrincipal(principal, BACKGROUND_CONTEXT);
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
