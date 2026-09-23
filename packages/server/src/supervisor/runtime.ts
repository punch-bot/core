import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AgentHarness,
	type AgentHarnessOptions,
	BACKGROUND_CONTEXT,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
} from "@punch-bot/agent";
import { NodeExecutionEnv } from "@punch-bot/agent/node";
import { createSandboxOperations } from "./operations.ts";

export interface SandboxRuntimeOptions {
	readonly directory: string;
	readonly models: AgentHarnessOptions["models"];
	readonly model: AgentHarnessOptions["model"];
	onError(error: unknown): void;
}

/** Container-local storage and execution. Closing a presentation does not close this runtime. */
export async function createSandboxRuntime(options: SandboxRuntimeOptions) {
	await mkdir(options.directory, { recursive: true, mode: 0o700 });
	const ownership = new DatabaseSync(join(options.directory, "runtime.owner"), { timeout: 0 });
	try {
		ownership.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		ownership.close();
		throw new Error("Sandbox already has a runtime writer", { cause: error });
	}
	const cwd = join(options.directory, "work");
	try {
		await mkdir(cwd, { recursive: true });
	} catch (error) {
		ownership.close();
		throw error;
	}
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(options.directory, "sessions") });
	let closed = false;
	let closing: Promise<void> | undefined;
	const open = async (metadata: JsonlSessionMetadata) => {
		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		let harness: AgentHarness | undefined;
		try {
			const created = await AgentHarness.create(
				{
					session,
					models: options.models,
					model: options.model,
					tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
					toolContext: { env },
					systemPrompt: `You are a coding agent working in ${cwd}. Use read, write, edit and bash to complete the task.`,
				},
				BACKGROUND_CONTEXT,
			);
			harness = created.harness;
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			const operations = createSandboxOperations(lane, options.onError);
			for (const operation of created.open) {
				if (operation.lane === "main") operations.resume(operation.operationId);
			}
			const active = harness;
			return {
				metadata,
				lane,
				operations: operations.service,
				async close() {
					const results = await Promise.allSettled([operations.close(), active.close(BACKGROUND_CONTEXT)]);
					const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
					if (errors.length) throw new AggregateError(errors, "Session cleanup failed");
				},
			};
		} catch (error) {
			await (harness ? harness.close(BACKGROUND_CONTEXT) : session.close(BACKGROUND_CONTEXT));
			throw error;
		}
	};
	const sessions = new Map<string, ReturnType<typeof open>>();
	const leases = new Map<string, number>();
	const idleTimers = new Map<string, NodeJS.Timeout>();
	const evicting = new Map<string, Promise<void>>();
	const mutations = new Set<Promise<unknown>>();
	const removals = new Map<string, Promise<void>>();
	const evict = async (id: string): Promise<void> => {
		idleTimers.delete(id);
		if (closed || leases.has(id) || removals.has(id)) return;
		const pending = sessions.get(id);
		if (!pending) return;
		try {
			const session = await pending;
			if (closed || leases.has(id) || removals.has(id)) return;
			if ((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current) {
				if (closed || leases.has(id) || removals.has(id)) return;
				const timer = setTimeout(() => void evict(id), 1_000);
				timer.unref();
				idleTimers.set(id, timer);
				return;
			}
			if (closed || removals.has(id) || sessions.get(id) !== pending || leases.has(id)) return;
			sessions.delete(id);
			const closingSession = session.close();
			evicting.set(id, closingSession);
			await closingSession;
		} catch (error) {
			try {
				options.onError(error);
			} catch {
				/* Error observers cannot interrupt cleanup. */
			}
		} finally {
			evicting.delete(id);
		}
	};
	return {
		async activity() {
			const results = await Promise.all(
				[...sessions.entries()].map(async ([sessionId, pending]) => {
					const session = await pending;
					const { current } = await session.lane.inspectExecution(BACKGROUND_CONTEXT);
					return current ? [{ sessionId, operationId: current.id, status: current.status }] : [];
				}),
			);
			return results.flat();
		},
		async list() {
			if (closed) throw new Error("Runtime closed");
			return repo.list(undefined, BACKGROUND_CONTEXT);
		},
		create(): Promise<JsonlSessionMetadata> {
			if (closed) return Promise.reject(new Error("Runtime closed"));
			const result = (async () => {
				const session = await repo.create({ id: randomUUID(), cwd }, BACKGROUND_CONTEXT);
				try {
					return session.metadata;
				} finally {
					await session.close(BACKGROUND_CONTEXT);
				}
			})();
			mutations.add(result);
			void result.finally(() => mutations.delete(result)).catch(() => {});
			return result;
		},
		async attach(id: string): ReturnType<typeof open> {
			if (closed) return Promise.reject(new Error("Runtime closed"));
			if (removals.has(id)) return Promise.reject(new Error("Session is being removed"));
			const idle = idleTimers.get(id);
			if (idle) {
				clearTimeout(idle);
				idleTimers.delete(id);
			}
			await evicting.get(id);
			if (closed || removals.has(id)) throw new Error("Runtime closed or session is being removed");
			const existing = sessions.get(id);
			if (existing) return existing;
			const pending = (async () => {
				const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((item) => item.id === id);
				if (!metadata) throw new Error("Session not found");
				return open(metadata);
			})();
			sessions.set(id, pending);
			void pending.catch(() => {
				if (sessions.get(id) === pending) sessions.delete(id);
			});
			return pending;
		},
		async lease(id: string) {
			leases.set(id, (leases.get(id) ?? 0) + 1);
			let session: Awaited<ReturnType<typeof open>>;
			try {
				session = await this.attach(id);
			} catch (error) {
				const count = leases.get(id)! - 1;
				if (count) leases.set(id, count);
				else leases.delete(id);
				throw error;
			}
			let released = false;
			return {
				session,
				release() {
					if (released) return;
					released = true;
					const count = leases.get(id)! - 1;
					if (count) leases.set(id, count);
					else {
						leases.delete(id);
						const timer = setTimeout(() => void evict(id), 0);
						timer.unref();
						idleTimers.set(id, timer);
					}
				},
			};
		},
		remove(id: string): Promise<void> {
			if (closed) return Promise.reject(new Error("Runtime closed"));
			const existing = removals.get(id);
			if (existing) return existing;
			const pending = (async () => {
				const idle = idleTimers.get(id);
				if (idle) clearTimeout(idle);
				idleTimers.delete(id);
				await evicting.get(id);
				const active = sessions.get(id);
				if (active) {
					await (await active).close();
					sessions.delete(id);
				}
				const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((session) => session.id === id);
				if (metadata) await repo.delete(metadata, BACKGROUND_CONTEXT);
			})();
			removals.set(id, pending);
			mutations.add(pending);
			void pending
				.finally(() => {
					removals.delete(id);
					mutations.delete(pending);
				})
				.catch(() => {});
			return pending;
		},
		close(): Promise<void> {
			closed = true;
			for (const timer of idleTimers.values()) clearTimeout(timer);
			idleTimers.clear();
			closing ??= (async () => {
				await Promise.allSettled([...mutations, ...evicting.values()]);
				const results = await Promise.allSettled(
					[...sessions.values()].map(async (session) => (await session).close()),
				);
				const storage = await Promise.allSettled([repo.close(BACKGROUND_CONTEXT), env.cleanup(BACKGROUND_CONTEXT)]);
				ownership.close();
				const errors = [...results, ...storage].flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				);
				if (errors.length) throw new AggregateError(errors, "Sandbox cleanup failed");
			})();
			return closing;
		},
	};
}
