import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/extensions/punch/collabs.ts";
import { handlePunchRequest } from "../src/extensions/punch/server.ts";

let root: string;

function collabEntries(): string[] {
	const dir = join(root, ".pi", "collab");
	return existsSync(dir) ? readdirSync(dir) : [];
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "punch-collabs-")));
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "users.json"),
		JSON.stringify([
			{ name: "alice", password: "alice-pass" },
			{ name: "bob", password: "bob-pass", workspace: join(root, "bob") },
			{ name: "carol", password: "carol-pass" },
		]),
	);
	mkdirSync(join(root, "project"), { recursive: true });
	writeFileSync(join(root, "project", "README.md"), "alice project\n");
	mkdirSync(join(root, "bob", "share"), { recursive: true });
	writeFileSync(join(root, "bob", "share", "notes.md"), "bob notes\n");
	symlinkSync(join(root, ".pi"), join(root, "bob", "pi-link"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	vi.spyOn(process, "cwd").mockReturnValue(root);
	vi.stubEnv("PI_SERVER_PASSWORD", "");
	vi.stubEnv("OPENCODE_SERVER_PASSWORD", "");
	vi.stubEnv("PI_WORKSPACE_ROOT", "");
	vi.stubEnv("PI_COLLAB_DIR", "");
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-home"));
	return () => {
		vi.restoreAllMocks();
	};
});

describe("collab workspace authorization", () => {
	it("rejects a non-owner exporting the server .pi directory or the owner's project", () => {
		expect(() => create({ owner: "bob", reviewer: "alice", workspace: join(root, ".pi") })).toThrow(
			"Workspace must be an absolute path under the workspace root.",
		);
		expect(() => create({ owner: "bob", reviewer: "alice", workspace: join(root, "project") })).toThrow(
			"Workspace must be an absolute path under the workspace root.",
		);
		expect(() => create({ owner: "bob", reviewer: "alice", workspace: join(root, "bob", "pi-link") })).toThrow(
			"Workspace must be an absolute path under the workspace root.",
		);
		expect(existsSync(join(root, ".pi", ".git"))).toBe(false);
		expect(existsSync(join(root, "project", ".git"))).toBe(false);
		expect(collabEntries()).toEqual([]);
	});

	it("rejects users without a configured workspace", () => {
		expect(() => create({ owner: "carol", reviewer: "alice", workspace: join(root, "project") })).toThrow(
			"No collaboration workspace is configured for this user.",
		);
		expect(existsSync(join(root, "project", ".git"))).toBe(false);
	});

	it("requires the reviewer to be a configured user", () => {
		expect(() => create({ owner: "alice", reviewer: "mallory", workspace: join(root, "project") })).toThrow(
			"reviewer must be a configured punch user",
		);
		expect(() => create({ owner: "alice", reviewer: "ALICE", workspace: join(root, "project") })).toThrow(
			"reviewer must be a different sandbox",
		);
		expect(existsSync(join(root, "project", ".git"))).toBe(false);
	});

	it("rejects workspaces that contain or sit inside punch server state", () => {
		expect(() => create({ owner: "alice", reviewer: "bob", workspace: join(root, ".pi", "sub") })).toThrow(
			"Workspace must not contain or be inside punch server state.",
		);
		expect(() => create({ owner: "alice", reviewer: "bob", workspace: join(root, "agent-home") })).toThrow(
			"Workspace must not contain or be inside punch server state.",
		);
		vi.stubEnv("PI_WORKSPACE_ROOT", join(root, ".."));
		expect(() => create({ owner: "alice", reviewer: "bob", workspace: root })).toThrow(
			"Workspace must not contain or be inside punch server state.",
		);
		expect(existsSync(join(root, ".git"))).toBe(false);
		expect(collabEntries()).toEqual([]);
	});

	it("creates collaborations inside the caller's own workspace root", () => {
		const owned = create({ owner: "alice", reviewer: "BOB", workspace: join(root, "project") });
		expect(owned.participants).toEqual(["alice", "bob"]);
		expect(owned.workspaces.alice).toBe(join(root, "project"));
		expect(existsSync(owned.repo)).toBe(true);

		const peer = create({ owner: "bob", reviewer: "alice", workspace: join(root, "bob", "share") });
		expect(peer.participants).toEqual(["bob", "alice"]);
		expect(existsSync(join(root, "bob", "share", ".git"))).toBe(true);
	});
});

describe("POST /collabs/create", () => {
	it("refuses a non-owner request for the server .pi directory without creating a repo", async () => {
		const server = createServer((req, res) => {
			void handlePunchRequest(req, res);
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP address");
			const before = collabEntries();
			const response = await fetch(`http://127.0.0.1:${address.port}/collabs/create`, {
				method: "POST",
				headers: {
					authorization: `Basic ${Buffer.from("bob:bob-pass").toString("base64")}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ reviewer: "alice", workspace: join(root, ".pi") }),
			});
			expect(response.ok).toBe(false);
			expect(((await response.json()) as { error: string }).error).toContain("workspace root");
			expect(existsSync(join(root, ".pi", ".git"))).toBe(false);
			expect(collabEntries()).toEqual(before);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
