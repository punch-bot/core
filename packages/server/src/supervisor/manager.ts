import { randomBytes, randomUUID } from "node:crypto";
import type { DockerEngine } from "./docker.ts";
import { waitForSandboxRuntime } from "./readiness.ts";
import type { SandboxRecord, SandboxRegistry } from "./registry.ts";

export interface SandboxRoute {
	readonly sandboxId: string;
	readonly generation: string;
	readonly url: string;
	readonly token: string;
}

export interface SupervisorOptions {
	readonly registry: SandboxRegistry;
	readonly engine: Pick<
		DockerEngine,
		"inspect" | "create" | "start" | "stop" | "remove" | "ensureVolume" | "removeVolume"
	>;
	readonly image: string;
	readonly network: string;
	readonly runtimeUrl: (record: SandboxRecord) => string;
	/** Must verify the runtime's sandbox ID and generation before resolving. */
	readonly ready?: (route: SandboxRoute, signal: AbortSignal) => Promise<void>;
	readonly readinessTimeoutMs?: number;
	readonly environment: (workspaceId: string) => Promise<Readonly<Record<string, string>>>;
}

/** Serializes each sandbox's lifecycle. Presentation disconnects never stop containers. */
export class SandboxSupervisor {
	readonly #options: SupervisorOptions;
	readonly #operations = new Map<string, Promise<unknown>>();
	#closing = false;
	constructor(options: SupervisorOptions) {
		if (!Number.isSafeInteger(options.readinessTimeoutMs ?? 30_000) || (options.readinessTimeoutMs ?? 30_000) <= 0)
			throw new Error("Invalid runtime readiness deadline");
		this.#options = options;
	}
	#run<T>(id: string, operation: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(new Error("Supervisor closed"));
		const result = (this.#operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
		this.#operations.set(id, result);
		void result
			.finally(() => {
				if (this.#operations.get(id) === result) this.#operations.delete(id);
			})
			.catch(() => {});
		return result;
	}
	async #inspect(record: SandboxRecord) {
		const container = await this.#options.engine.inspect(record.container);
		if (
			container &&
			(container.labels["punch.owner"] !== this.#options.registry.owner ||
				container.labels["punch.sandbox"] !== record.id ||
				container.labels["punch.generation"] !== record.generation)
		)
			throw new Error("Container ownership or generation mismatch");
		return container;
	}
	acquire(id: string, workspaceId: string): Promise<SandboxRoute> {
		return this.#run(id, async () => {
			const { registry, engine } = this.#options;
			let record = registry.get(id, workspaceId);
			if (record.desired === "deleted") throw new Error("Sandbox deleted");
			const save = (next: SandboxRecord): void => {
				registry.save(next, record);
				record = next;
			};
			try {
				let container = await this.#inspect(record);
				// A second presentation must not invalidate an already serving generation.
				if (!container?.running || record.state !== "ready" || record.desired !== "running")
					save({ ...record, desired: "running", state: "starting" });
				if (container && !container.running) {
					await engine.remove(record.container);
					container = undefined;
				}
				if (!container) {
					// Rotate even when Docker lost the old container entirely.
					save({ ...record, generation: randomUUID(), token: randomBytes(32).toString("base64url") });
					await engine.ensureVolume(record.volume, { "punch.owner": registry.owner, "punch.sandbox": record.id });
					await engine.create({
						name: record.container,
						image: this.#options.image,
						network: this.#options.network,
						volume: record.volume,
						memoryBytes: 1024 ** 3,
						nanoCpus: 1_000_000_000,
						labels: {
							"punch.owner": registry.owner,
							"punch.sandbox": record.id,
							"punch.generation": record.generation,
						},
						environment: {
							...(await this.#options.environment(workspaceId)),
							PUNCH_SANDBOX_ID: id,
							PUNCH_WORKSPACE_ID: workspaceId,
							PUNCH_RUNTIME_GENERATION: record.generation,
							PUNCH_RUNTIME_TOKEN: record.token,
							PUNCH_RUNTIME_PORT: "8080",
							PUNCH_SANDBOX_DIRECTORY: "/sandbox",
						},
					});
					await engine.start(record.container);
				}
				const route = {
					sandboxId: id,
					generation: record.generation,
					token: record.token,
					url: this.#options.runtimeUrl(record),
				};
				const controller = new AbortController();
				const timer = setTimeout(
					() => controller.abort(new Error("Runtime readiness timed out")),
					this.#options.readinessTimeoutMs ?? 30_000,
				);
				try {
					await new Promise<void>((resolve, reject) => {
						controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
						void Promise.resolve()
							.then(() => (this.#options.ready ?? waitForSandboxRuntime)(route, controller.signal))
							.then(resolve, reject);
					});
				} finally {
					clearTimeout(timer);
				}
				save({ ...record, state: "ready" });
				return route;
			} catch (error) {
				save({ ...record, state: "failed" });
				throw error;
			}
		});
	}
	stop(id: string, workspaceId: string): Promise<void> {
		return this.#run(id, async () => {
			const { registry, engine } = this.#options;
			const previous = registry.get(id, workspaceId);
			if (previous.desired === "deleted") throw new Error("Sandbox deleted");
			const stopping: SandboxRecord = { ...previous, desired: "stopped", state: "stopping" };
			registry.save(stopping, previous);
			try {
				if ((await this.#inspect(stopping))?.running) await engine.stop(stopping.container, 10);
				if ((await this.#inspect(stopping))?.running) throw new Error("Sandbox writer did not stop");
				registry.save({ ...stopping, state: "stopped" }, stopping);
			} catch (error) {
				registry.save({ ...stopping, state: "failed" }, stopping);
				throw error;
			}
		});
	}
	async close(): Promise<void> {
		this.#closing = true;
		await Promise.allSettled(this.#operations.values());
	}
	delete(id: string, workspaceId: string, deleteData: boolean): Promise<void> {
		return this.#run(id, async () => {
			const { registry, engine } = this.#options;
			const previous = registry.get(id, workspaceId);
			if (previous.state === "deleted" && (previous.deleteData || !deleteData)) return;
			const deleting: SandboxRecord = {
				...previous,
				desired: "deleted",
				state: "stopping",
				deleteData: previous.deleteData || deleteData,
			};
			registry.save(deleting, previous);
			try {
				const container = await this.#inspect(deleting);
				if (container?.running) await engine.stop(deleting.container, 10);
				if ((await this.#inspect(deleting))?.running) throw new Error("Sandbox writer did not stop");
				if (container) await engine.remove(deleting.container);
				if (deleting.deleteData) {
					await engine.ensureVolume(deleting.volume, { "punch.owner": registry.owner, "punch.sandbox": id });
					await engine.removeVolume(deleting.volume);
				}
				registry.save({ ...deleting, state: "deleted" }, deleting);
			} catch (error) {
				registry.save({ ...deleting, state: "failed" }, deleting);
				throw error;
			}
		});
	}
	/** Adopt live generations; finish interrupted stop/delete operations without touching unrelated containers. */
	async reconcile(): Promise<{ sandboxId: string; error: unknown }[]> {
		const records = this.#options.registry.list().filter((record) => record.state !== "deleted");
		const results = await Promise.allSettled(
			records.map((record) => {
				if (record.desired === "running") return this.acquire(record.id, record.workspaceId);
				if (record.desired === "deleted") return this.delete(record.id, record.workspaceId, record.deleteData);
				return this.stop(record.id, record.workspaceId);
			}),
		);
		return results.flatMap((result, index) => {
			if (result.status === "fulfilled") return [];
			const record = records[index]!;
			// A recoverable lifecycle failure must have been durably recorded. Registry failures remain fatal.
			if (this.#options.registry.get(record.id, record.workspaceId).state !== "failed") throw result.reason;
			return [{ sandboxId: record.id, error: result.reason }];
		});
	}
}
