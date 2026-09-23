import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, SessionMetadata } from "@punch-bot/agent";
import {
	createRemoteServiceEndpoint,
	decodeServiceControlCall,
	RemoteServiceError,
	RemoteServiceProvider,
} from "@punch-bot/chord";
import { getPrincipal } from "../principal.ts";
import { type GatewaySessionSummary, GatewaySessions, RuntimeSessions, SandboxOperations } from "../services.ts";
import type { ServerHost } from "../types.ts";
import type { SupervisorClient } from "./control.ts";
import { connectSandboxRuntime } from "./remote-client.ts";
import { createRemoteSessionHandle } from "./remote-session.ts";

interface RemoteSessionMetadata extends SessionMetadata {
	sandboxId: string;
	workspaceId: string;
}

/** The gateway stores routing metadata; session files and model execution stay inside sandboxes. */
export function createSandboxGatewayHost(options: {
	readonly databasePath: string;
	readonly supervisor: SupervisorClient;
	readonly authorizePrincipal?: (context: Context) => Promise<void>;
	readonly onSessionRemoved?: (id: string, context: Context) => Promise<void>;
}): { host: ServerHost<RemoteSessionMetadata>; close(): Promise<void> } {
	if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(options.databasePath, { timeout: 5_000 });
	try {
		if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
		database.exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS sandbox_gateway_sessions (
				id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, sandbox_id TEXT NOT NULL, created_at INTEGER NOT NULL
			);`);
	} catch (error) {
		database.close();
		throw error;
	}
	let closed = false;
	const pending = new Set<Promise<unknown>>();
	const providers = new Set<RemoteServiceProvider>();
	const removing = new Set<string>();
	const authorize = (permission: string, context: Context): string => {
		const principal = getPrincipal(context);
		if (closed || !principal || !principal.permissions.includes(permission))
			throw new RemoteServiceError("service_not_allowed", "Gateway access denied");
		return principal.workspaceId;
	};
	const resolve = (id: string, context: Context): RemoteSessionMetadata => {
		const workspaceId = authorize("sessions:read", context);
		const row = database
			.prepare("SELECT sandbox_id, created_at FROM sandbox_gateway_sessions WHERE id=? AND workspace_id=?")
			.get(id, workspaceId);
		if (!row) throw new RemoteServiceError("service_not_allowed", "Session access denied");
		if (removing.has(id)) throw new Error("Session is being removed");
		return {
			id,
			workspaceId,
			sandboxId: String(row.sandbox_id),
			createdAt: Number(row.created_at),
			storageVersion: 1,
		};
	};
	const create = async (sandboxId: string | null, context: Context): Promise<GatewaySessionSummary> => {
		const workspaceId = authorize("sessions:create", context);
		authorize("sessions:read", context);
		const sandbox =
			sandboxId === null
				? await options.supervisor.create(workspaceId)
				: await options.supervisor.inspect(sandboxId, workspaceId);
		if (sandbox.workspaceId !== workspaceId || (sandboxId !== null && sandbox.id !== sandboxId))
			throw new Error("Supervisor returned the wrong sandbox");
		const route = await options.supervisor.acquire(sandbox.id, workspaceId);
		if (route.sandboxId !== sandbox.id) throw new Error("Supervisor route mismatch");
		const client = await connectSandboxRuntime(route, getPrincipal(context)!);
		try {
			const result = await client.request(
				{ serverId: sandbox.id },
				{ serviceId: RuntimeSessions.id, member: "create", args: [] },
				context.abortSignal,
			);
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				typeof result.id !== "string" ||
				typeof result.createdAt !== "number"
			)
				throw new Error("Invalid runtime session response");
			database
				.prepare("INSERT INTO sandbox_gateway_sessions VALUES (?, ?, ?, ?)")
				.run(result.id, workspaceId, sandbox.id, result.createdAt);
			return { sessionId: result.id, sandboxId: sandbox.id, createdAt: result.createdAt };
		} finally {
			await client.dispose();
		}
	};
	return {
		host: {
			serverServices: {
				attachClient(presentation, context) {
					authorize("sessions:read", context);
					const provider = new RemoteServiceProvider([{ service: GatewaySessions, mode: "singleton" }]);
					providers.add(provider);
					provider.provide(GatewaySessions, {
						async list(ctx) {
							const workspaceId = authorize("sessions:read", ctx);
							return database
								.prepare(
									"SELECT id,sandbox_id,created_at FROM sandbox_gateway_sessions WHERE workspace_id=? ORDER BY created_at,id",
								)
								.all(workspaceId)
								.map((row) => ({
									sessionId: String(row.id),
									sandboxId: String(row.sandbox_id),
									createdAt: Number(row.created_at),
								}));
						},
						create(sandboxId, ctx) {
							const operation = create(sandboxId, ctx);
							pending.add(operation);
							void operation.finally(() => pending.delete(operation)).catch(() => {});
							return operation;
						},
						remove(id, ctx) {
							const operation = (async () => {
								authorize("sessions:remove", ctx);
								const metadata = resolve(id, ctx);
								removing.add(id);
								try {
									await presentation.prepareSessionRemoval(id, ctx);
									const sandbox = await options.supervisor.inspect(metadata.sandboxId, metadata.workspaceId);
									if (sandbox.id !== metadata.sandboxId || sandbox.workspaceId !== metadata.workspaceId)
										throw new Error("Supervisor returned the wrong sandbox");
									if (sandbox.state !== "deleted") {
										const route = await options.supervisor.acquire(metadata.sandboxId, metadata.workspaceId);
										if (route.sandboxId !== metadata.sandboxId) throw new Error("Supervisor route mismatch");
										const client = await connectSandboxRuntime(route, getPrincipal(ctx)!);
										try {
											await client.request(
												{ serverId: metadata.sandboxId },
												{ serviceId: RuntimeSessions.id, member: "remove", args: [id] },
												ctx.abortSignal,
											);
										} finally {
											await client.dispose();
										}
									}
									database
										.prepare("DELETE FROM sandbox_gateway_sessions WHERE id=? AND workspace_id=?")
										.run(id, metadata.workspaceId);
									await options.onSessionRemoved?.(id, ctx);
								} finally {
									removing.delete(id);
								}
							})();
							pending.add(operation);
							void operation.finally(() => pending.delete(operation)).catch(() => {});
							return operation;
						},
						async attach(id, ctx) {
							resolve(id, ctx);
							await presentation.attachSession(id, ctx);
						},
						detach: (ctx) => presentation.detachSession(ctx),
					});
					const endpoint = createRemoteServiceEndpoint(provider);
					return {
						async invokeService(call, publish, ctx) {
							await options.authorizePrincipal?.(ctx);
							return endpoint.invoke(call, publish, ctx);
						},
						release() {
							endpoint.dispose();
							provider.dispose();
							providers.delete(provider);
						},
					};
				},
			},
			async authorizeSession(id, call, context) {
				await options.authorizePrincipal?.(context);
				resolve(id, context);
				const read =
					call === undefined ||
					decodeServiceControlCall(call) ||
					(call.serviceId === SandboxOperations.id && (call.member === "status" || call.member === "current"));
				authorize(read ? "sessions:read" : "sessions:control", context);
			},
			async resolveSession(id, context) {
				return resolve(id, context);
			},
			async openSession(metadata, context) {
				resolve(metadata.id, context);
				return createRemoteSessionHandle({
					supervisor: options.supervisor,
					sandboxId: metadata.sandboxId,
					sessionId: metadata.id,
					workspaceId: metadata.workspaceId,
					async authorize(ctx) {
						await options.authorizePrincipal?.(ctx);
						resolve(metadata.id, ctx);
					},
				});
			},
		},
		async close() {
			if (closed) return;
			closed = true;
			await Promise.allSettled(pending);
			for (const provider of providers) provider.dispose();
			providers.clear();
			database.close();
		},
	};
}
