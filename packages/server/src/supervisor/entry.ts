import { readFile } from "node:fs/promises";
import { installShutdown, requiredEnvironment as required } from "../deployment/process.ts";
import { startSupervisorControl } from "./control.ts";
import { DockerEngine } from "./docker.ts";
import { SandboxSupervisor } from "./manager.ts";
import { SandboxRegistry } from "./registry.ts";

const image = required("PUNCH_RUNTIME_IMAGE");
if (!/^(?:sha256:|.+@sha256:)[a-f0-9]{64}$/.test(image)) throw new Error("Runtime image must be pinned by digest");
const network = required("PUNCH_DOCKER_NETWORK");
const environmentPath = required("PUNCH_WORKSPACE_ENVIRONMENTS");
const token = required("PUNCH_SUPERVISOR_TOKEN");
const registry = new SandboxRegistry(required("PUNCH_SUPERVISOR_DATABASE"));
const supervisor = new SandboxSupervisor({
	registry,
	image,
	network,
	engine: new DockerEngine({ socketPath: process.env.PUNCH_DOCKER_SOCKET }),
	runtimeUrl: (record) => `http://${record.container}:8080`,
	async environment(workspaceId) {
		const value: unknown = JSON.parse(await readFile(environmentPath, "utf8"));
		if (!value || typeof value !== "object" || !Object.hasOwn(value, workspaceId))
			throw new Error("Workspace runtime environment is not provisioned");
		const environment: unknown = Reflect.get(value, workspaceId);
		if (
			!environment ||
			typeof environment !== "object" ||
			Array.isArray(environment) ||
			Object.entries(environment).some(
				([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"),
			)
		)
			throw new Error("Invalid workspace runtime environment");
		return environment as Record<string, string>;
	},
});
try {
	await supervisor.reconcile();
	const control = await startSupervisorControl({
		supervisor,
		registry,
		token,
		hostname: "0.0.0.0",
		onError: console.error,
	});
	installShutdown(async () => {
		try {
			await control.close();
			await supervisor.close();
		} finally {
			registry.close();
		}
	}, 120_000);
} catch (error) {
	await supervisor.close();
	registry.close();
	throw error;
}
