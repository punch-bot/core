import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SandboxRegistry } from "../src/supervisor/registry.ts";

test("persists lifecycle intent and rejects stale writers and cross-workspace lookup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-registry-"));
	const path = join(directory, "registry.db");
	let registry: SandboxRegistry | undefined;
	try {
		registry = new SandboxRegistry(path);
		expect(() => new SandboxRegistry(path)).toThrow("already owned");
		const original = registry.create("workspace-a");
		const owner = registry.owner;
		expect(() => registry!.get(original.id, "workspace-b")).toThrow("Sandbox not found");
		const deleting = { ...original, desired: "deleted" as const, deleteData: true };
		registry.save(deleting, original);
		expect(() => registry!.save({ ...original, desired: "running" }, original)).toThrow("Sandbox changed");
		registry.close();
		registry = undefined;
		registry = new SandboxRegistry(path);
		expect(registry.owner).toBe(owner);
		expect(registry.get(original.id, "workspace-a")).toEqual(deleting);
	} finally {
		registry?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
