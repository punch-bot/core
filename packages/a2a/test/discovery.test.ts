import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { delegateToA2aAgent } from "../src/client.ts";
import { defaultA2aDiscoveryDir, LocalA2aDiscovery } from "../src/discovery.ts";
import { createA2aServer } from "../src/server.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "punch-a2a-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("defaultA2aDiscoveryDir", () => {
	test("prefers PUNCH_A2A_DISCOVERY_DIR", () => {
		expect(defaultA2aDiscoveryDir({ PUNCH_A2A_DISCOVERY_DIR: "/var/punch/a2a" })).toBe(
			path.resolve("/var/punch/a2a"),
		);
	});

	test("uses XDG_RUNTIME_DIR when unset", () => {
		expect(defaultA2aDiscoveryDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
			path.join("/run/user/1000", "punch", "a2a"),
		);
	});
});

describe("LocalA2aDiscovery", () => {
	test("advertises and discovers peers in the same directory", () => {
		const dir = tempDir();
		const alive = new Set([11, 22]);
		const alice = new LocalA2aDiscovery({
			dir,
			now: () => 1_000,
			isAlive: (pid) => alive.has(pid),
		});
		const bob = new LocalA2aDiscovery({
			dir,
			now: () => 1_000,
			isAlive: (pid) => alive.has(pid),
		});

		alice.advertise({
			id: "alice-id",
			name: "alice",
			url: "http://127.0.0.1:41241/",
			pid: 11,
			startedAt: 1_000,
		});
		bob.advertise({
			id: "bob-id",
			name: "bob",
			url: "http://127.0.0.1:41242/",
			pid: 22,
			cwd: "/work/bob",
			startedAt: 1_000,
		});

		expect(alice.list()).toEqual([
			{
				id: "bob-id",
				name: "bob",
				url: "http://127.0.0.1:41242/",
				pid: 22,
				cwd: "/work/bob",
				startedAt: 1_000,
				updatedAt: 1_000,
			},
		]);
		expect(bob.find("Alice")?.id).toBe("alice-id");
		expect(alice.find("missing")).toBeUndefined();
	});

	test("drops stale and dead advertisements", () => {
		const dir = tempDir();
		let now = 1_000;
		const alive = new Set([11, 22]);
		const alice = new LocalA2aDiscovery({
			dir,
			ttlMs: 100,
			now: () => now,
			isAlive: (pid) => alive.has(pid),
		});
		const bob = new LocalA2aDiscovery({
			dir,
			ttlMs: 100,
			now: () => now,
			isAlive: (pid) => alive.has(pid),
		});
		const carol = new LocalA2aDiscovery({
			dir,
			ttlMs: 100,
			now: () => now,
			isAlive: (pid) => alive.has(pid),
		});

		alice.advertise({
			id: "alice-id",
			name: "alice",
			url: "http://127.0.0.1:1/",
			pid: 11,
			startedAt: now,
		});
		bob.advertise({
			id: "bob-id",
			name: "bob",
			url: "http://127.0.0.1:2/",
			pid: 22,
			startedAt: now,
		});
		carol.advertise({
			id: "carol-id",
			name: "carol",
			url: "http://127.0.0.1:3/",
			pid: 33,
			startedAt: now,
		});

		alive.delete(33);
		now = 1_050;
		expect(alice.list().map((peer) => peer.name)).toEqual(["bob"]);

		now = 1_200;
		expect(alice.list()).toEqual([]);
	});

	test("discovered peers are reachable over A2A", async () => {
		const dir = tempDir();
		const server = await createA2aServer({
			name: "bob",
			runnerFactory: () => ({
				async prompt(text) {
					return { text: `bob:${text}` };
				},
			}),
		});
		const bound = await server.listen(0, "127.0.0.1");
		const alice = new LocalA2aDiscovery({ dir, isAlive: () => true });
		const bob = new LocalA2aDiscovery({ dir, isAlive: () => true });
		try {
			bob.advertise({
				id: "bob-id",
				name: "bob",
				url: bound.url,
				pid: 22,
				startedAt: Date.now(),
			});
			const peer = alice.find("bob");
			expect(peer?.url).toBe(bound.url);
			const result = await delegateToA2aAgent({ url: peer!.url, task: "hi" });
			expect(result.text).toBe("bob:hi");
		} finally {
			alice.close();
			bob.close();
			await server.close();
		}
	});

	test("close removes the local advertisement", () => {
		const dir = tempDir();
		const alice = new LocalA2aDiscovery({ dir, now: () => 1, isAlive: () => true });
		const bob = new LocalA2aDiscovery({ dir, now: () => 1, isAlive: () => true });
		alice.advertise({
			id: "alice-id",
			name: "alice",
			url: "http://127.0.0.1:1/",
			pid: 11,
			startedAt: 1,
		});
		expect(bob.list()).toHaveLength(1);
		alice.close();
		expect(bob.list()).toHaveLength(0);
	});
});
