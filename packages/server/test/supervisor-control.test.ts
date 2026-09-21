import { expect, test } from "vitest";
import { createSupervisorClient, startSupervisorControl } from "../src/supervisor/control.ts";
import type { SandboxContainerState } from "../src/supervisor/docker.ts";
import { SandboxSupervisor } from "../src/supervisor/manager.ts";
import { SandboxRegistry } from "../src/supervisor/registry.ts";

test("private control authenticates, preserves deletion intent, and reconciles after failure", async () => {
	const registry = new SandboxRegistry(":memory:");
	let container: SandboxContainerState | undefined;
	let failDeletion = true;
	let deletedVolumes = 0;
	const supervisor = new SandboxSupervisor({
		registry,
		image: `sha256:${"a".repeat(64)}`,
		network: "test",
		runtimeUrl: () => "http://runtime:8080",
		async ready() {},
		async environment() {
			return {};
		},
		engine: {
			async inspect() {
				return container;
			},
			async create(spec) {
				container = { id: "container", running: false, labels: spec.labels };
			},
			async start() {
				container = { ...container!, running: true };
			},
			async stop() {
				container = { ...container!, running: false };
			},
			async remove() {
				if (failDeletion) throw new Error("Daemon unavailable");
				container = undefined;
			},
			async ensureVolume() {},
			async removeVolume() {
				deletedVolumes++;
			},
		},
	});
	const token = "s".repeat(32);
	const control = await startSupervisorControl({ registry, supervisor, token, port: 0, onError() {} });
	const client = createSupervisorClient(control.url, token);
	try {
		await expect(createSupervisorClient(control.url, "wrong").create("workspace")).rejects.toThrow("401");
		expect(registry.list()).toEqual([]);
		const sandbox = await client.create("workspace");
		expect(sandbox).not.toHaveProperty("token");
		const route = await client.acquire(sandbox.id, "workspace");
		expect(route.token).toHaveLength(43);
		await expect(client.acquire(sandbox.id, "other")).rejects.toThrow();
		const invalid = await fetch(`${control.url}/v1/sandboxes`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ action: "delete", sandboxId: sandbox.id, workspaceId: "workspace" }),
		});
		expect(invalid.status).toBe(400);
		expect(registry.get(sandbox.id, "workspace").desired).toBe("running");
		await expect(client.delete(sandbox.id, "workspace", true)).rejects.toThrow();
		expect(registry.get(sandbox.id, "workspace")).toMatchObject({
			desired: "deleted",
			state: "failed",
			deleteData: true,
		});
		failDeletion = false;
		await supervisor.reconcile();
		expect(await client.inspect(sandbox.id, "workspace")).toMatchObject({ state: "deleted", deleteData: true });
		expect(deletedVolumes).toBe(1);
		await expect(client.acquire(sandbox.id, "workspace")).rejects.toThrow();
	} finally {
		await control.close();
		await supervisor.close();
		registry.close();
	}
});

test("readiness deadline releases acquisition even if a callback ignores cancellation", async () => {
	const registry = new SandboxRegistry(":memory:");
	const sandbox = registry.create("workspace");
	const supervisor = new SandboxSupervisor({
		registry,
		image: `sha256:${"a".repeat(64)}`,
		network: "test",
		runtimeUrl: () => "http://runtime:8080",
		readinessTimeoutMs: 20,
		ready: () => new Promise(() => {}),
		async environment() {
			return {};
		},
		engine: {
			async inspect() {
				return undefined;
			},
			async create() {},
			async start() {},
			async stop() {},
			async remove() {},
			async ensureVolume() {},
			async removeVolume() {},
		},
	});
	try {
		await expect(supervisor.acquire(sandbox.id, "workspace")).rejects.toThrow("readiness timed out");
		expect(registry.get(sandbox.id, "workspace").state).toBe("failed");
		await supervisor.close();
	} finally {
		registry.close();
	}
});
