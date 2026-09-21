import { expect, test } from "vitest";
import type { SandboxContainerSpec, SandboxContainerState } from "../src/supervisor/docker.ts";
import { SandboxSupervisor } from "../src/supervisor/manager.ts";
import { SandboxRegistry } from "../src/supervisor/registry.ts";

test("concurrent acquisition converges and restart rotates only after stopping the writer", async () => {
	const registry = new SandboxRegistry(":memory:");
	const sandbox = registry.create("workspace");
	let container: SandboxContainerState | undefined;
	let creates = 0;
	let starts = 0;
	let stops = 0;
	let volumes = 0;
	let readinessCalls = 0;
	const supervisor = new SandboxSupervisor({
		registry,
		image: `sha256:${"a".repeat(64)}`,
		network: "private",
		runtimeUrl: () => "http://runtime:8080",
		async environment() {
			return {};
		},
		async ready() {
			readinessCalls++;
			if (readinessCalls > 1 && readinessCalls <= 5)
				expect(registry.get(sandbox.id, "workspace")).toMatchObject({ state: "ready", desired: "running" });
		},
		engine: {
			async inspect() {
				return container;
			},
			async create(spec: SandboxContainerSpec) {
				creates++;
				container = { id: "container", running: false, labels: spec.labels };
			},
			async start() {
				starts++;
				container = { ...container!, running: true };
			},
			async stop() {
				stops++;
				container = { ...container!, running: false };
			},
			async remove() {
				expect(container?.running).toBe(false);
				container = undefined;
			},
			async ensureVolume() {
				volumes++;
			},
			async removeVolume() {
				throw new Error("Must retain data");
			},
		},
	});
	try {
		const routes = await Promise.all(Array.from({ length: 5 }, () => supervisor.acquire(sandbox.id, "workspace")));
		expect(creates).toBe(1);
		expect(starts).toBe(1);
		expect(new Set(routes.map((route) => route.generation)).size).toBe(1);
		await expect(supervisor.acquire(sandbox.id, "other")).rejects.toThrow("Sandbox not found");
		expect(creates).toBe(1);
		await supervisor.stop(sandbox.id, "workspace");
		const next = await supervisor.acquire(sandbox.id, "workspace");
		expect(next.generation).not.toBe(routes[0]!.generation);
		expect(next.token).not.toBe(routes[0]!.token);
		expect(registry.get(sandbox.id, "workspace").volume).toBe(sandbox.volume);
		expect(volumes).toBe(2);
		expect(stops).toBe(1);
		container = undefined;
		const replacement = await supervisor.acquire(sandbox.id, "workspace");
		expect(replacement.generation).not.toBe(next.generation);
		expect(replacement.token).not.toBe(next.token);
		expect(creates).toBe(3);
		await supervisor.close();
		expect(container).toMatchObject({ running: true });
	} finally {
		await supervisor.close();
		registry.close();
	}
});

test("supervisor restart adopts the live generation and preserves its route credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-adoption-"));
	const path = join(directory, "registry.db");
	let registry = new SandboxRegistry(path);
	let container: SandboxContainerState | undefined;
	let starts = 0;
	const options = {
		image: `sha256:${"a".repeat(64)}`,
		network: "private",
		runtimeUrl: () => "http://runtime:8080",
		async ready() {},
		async environment() {
			return {};
		},
		engine: {
			async inspect() {
				return container;
			},
			async create(spec: SandboxContainerSpec) {
				container = { id: "container", running: false, labels: spec.labels };
			},
			async start() {
				starts++;
				container = { ...container!, running: true };
			},
			async stop() {
				throw new Error("Adoption must not stop a live writer");
			},
			async remove() {
				throw new Error("Adoption must not remove a live writer");
			},
			async ensureVolume() {},
			async removeVolume() {
				throw new Error("Adoption must preserve data");
			},
		},
	};
	let supervisor = new SandboxSupervisor({ ...options, registry });
	try {
		const sandbox = registry.create("workspace");
		const route = await supervisor.acquire(sandbox.id, "workspace");
		await supervisor.close();
		registry.close();
		registry = new SandboxRegistry(path);
		supervisor = new SandboxSupervisor({ ...options, registry });
		await supervisor.reconcile();
		expect(await supervisor.acquire(sandbox.id, "workspace")).toEqual(route);
		expect(starts).toBe(1);
	} finally {
		await supervisor.close();
		registry.close();
		await rm(directory, { recursive: true, force: true });
	}
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
