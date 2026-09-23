import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
	BACKGROUND_CONTEXT,
	type Context,
	type JsonlSessionMetadata,
	type LaneTranscriptSnapshot,
	reduceLaneSnapshot,
} from "@punch-bot/agent";
import {
	createRemoteServiceEndpoint,
	decodeServiceControlCall,
	RemoteServiceError,
	RemoteServiceProvider,
	replicatedState,
} from "@punch-bot/chord";
import { isServerId } from "@punch-bot/protocol";
import { getPrincipal } from "../principal.ts";
import { Server } from "../server.ts";
import { RuntimeModels, RuntimeSessions, RuntimeTranscript, SandboxOperations } from "../services.ts";
import type { ServerHost } from "../types.ts";
import { createWebSocketListener } from "../websocket.ts";
import { verifyRuntimeCapability } from "./capability.ts";
import { createSandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

export async function startSandboxRuntimeServer(
	options: SandboxRuntimeOptions & {
		readonly sandboxId: string;
		readonly workspaceId: string;
		readonly generation: string;
		readonly token: string;
		readonly port?: number;
		readonly hostname?: string;
	},
): Promise<{ url: string; close(): Promise<void> }> {
	if (options.token.length < 32) throw new Error("Runtime secret is too short");
	if (!isServerId(options.sandboxId)) throw new Error("Sandbox ID must be a UUIDv4");
	const runtime = await createSandboxRuntime(options);
	let closing = false;
	const authorize = (permission: string, context: Context): void => {
		const principal = getPrincipal(context);
		if (closing || principal?.workspaceId !== options.workspaceId || !principal.permissions.includes(permission))
			throw new RemoteServiceError("service_not_allowed", "Sandbox access denied");
	};
	const host: ServerHost<JsonlSessionMetadata> = {
		serverServices: {
			attachClient(presentation, context) {
				authorize("sessions:read", context);
				const provider = new RemoteServiceProvider([{ service: RuntimeSessions, mode: "singleton" }]);
				provider.provide(RuntimeSessions, {
					async list(ctx) {
						authorize("sessions:read", ctx);
						return (await runtime.list()).map(({ id, createdAt }) => ({ id, createdAt }));
					},
					async create(ctx) {
						authorize("sessions:create", ctx);
						const { id, createdAt } = await runtime.create();
						return { id, createdAt };
					},
					async remove(id, ctx) {
						authorize("sessions:remove", ctx);
						await presentation.prepareSessionRemoval(id, ctx);
						await runtime.remove(id);
					},
					async attach(id, ctx) {
						authorize("sessions:read", ctx);
						await presentation.attachSession(id, ctx);
					},
					detach: (ctx) => presentation.detachSession(ctx),
				});
				const endpoint = createRemoteServiceEndpoint(provider);
				return {
					invokeService: (call, publish, ctx) => endpoint.invoke(call, publish, ctx),
					release() {
						endpoint.dispose();
						provider.dispose();
					},
				};
			},
		},
		authorizeSession(_id, call, ctx) {
			authorize(
				call === undefined ||
					decodeServiceControlCall(call) ||
					(call.serviceId === SandboxOperations.id && (call.member === "status" || call.member === "current"))
					? "sessions:read"
					: "sessions:control",
				ctx,
			);
		},
		async resolveSession(id) {
			const metadata = (await runtime.list()).find((session) => session.id === id);
			if (!metadata) throw new RemoteServiceError("service_invalid_value", "Session not found");
			return metadata;
		},
		async openSession(metadata) {
			return {
				async attachClient() {
					const { session, release } = await runtime.lease(metadata.id);
					try {
						const watch = await session.lane.watch(BACKGROUND_CONTEXT);
						const state = replicatedState({ snapshot: watch.snapshot as LaneTranscriptSnapshot });
						let updates = Promise.resolve();
						let released = false;
						watch.start((event) => {
							updates = updates
								.then(async () => {
									if (released) return;
									if (reduceLaneSnapshot(state.state.snapshot, event) === "rebase")
										state.state.snapshot = (await watch.resnapshot(
											BACKGROUND_CONTEXT,
										)) as LaneTranscriptSnapshot;
									state.publish(BACKGROUND_CONTEXT);
								})
								.catch((error) => {
									try {
										options.onError(error);
									} catch {}
								});
						});
						const provider = new RemoteServiceProvider([
							{ service: SandboxOperations, mode: "singleton" },
							{ service: RuntimeTranscript, mode: "singleton" },
							{ service: RuntimeModels, mode: "singleton" },
						]);
						provider.provide(SandboxOperations, session.operations);
						provider.provide(RuntimeTranscript, { state });
						provider.provide(RuntimeModels, {
							async select(model, context) {
								if (
									!model ||
									typeof model.provider !== "string" ||
									typeof model.modelId !== "string" ||
									!options.models.getModel(model.provider, model.modelId)
								)
									throw new RemoteServiceError("service_invalid_value", "Model is unavailable");
								await session.lane.setModel(model, context);
							},
						});
						const endpoint = createRemoteServiceEndpoint(provider);
						return {
							invokeService: (call, publish, ctx) => endpoint.invoke(call, publish, ctx),
							async release() {
								released = true;
								watch.unsubscribe();
								try {
									await updates;
								} finally {
									endpoint.dispose();
									provider.dispose();
									release();
								}
							},
						};
					} catch (error) {
						release();
						throw error;
					}
				},
				async close() {},
			};
		},
	};
	const http = createServer((request, response) => {
		const token = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
		const expected = Buffer.from(options.token);
		if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
			response.writeHead(401).end();
			return;
		}
		if (request.url !== "/ready" || request.method !== "GET") {
			response.writeHead(404).end();
			return;
		}
		void runtime.activity().then(
			(activity) => {
				// Readiness only needs identity; bound the diagnostic list to the 4 KiB reader limit.
				const activeOperations = activity.slice(0, 8);
				response
					.writeHead(closing ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" })
					.end(JSON.stringify({ sandboxId: options.sandboxId, generation: options.generation, activeOperations }));
			},
			() => response.writeHead(503).end(),
		);
	});
	const listener = createWebSocketListener({
		server: http,
		async authenticate(request) {
			return verifyRuntimeCapability(
				request.headers.authorization?.replace(/^Bearer /, "") ?? "",
				options.token,
				options.generation,
				options.workspaceId,
			);
		},
	});
	const server = new Server(host, { serverId: options.sandboxId, listeners: [listener], onError: options.onError });
	let closed: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing = true;
		closed ??= (async () => {
			const results = await Promise.allSettled([server.close(), runtime.close()]);
			await new Promise<void>((resolve) => {
				http.close(() => resolve());
				http.closeAllConnections();
			});
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "Runtime server shutdown failed");
		})();
		return closed;
	};
	try {
		await server.start();
		await new Promise<void>((resolve, reject) => {
			http.once("error", reject);
			http.listen(options.port ?? 8080, options.hostname ?? "0.0.0.0", () => {
				http.off("error", reject);
				http.on("error", (error) => {
					try {
						options.onError(error);
					} catch {}
				});
				resolve();
			});
		});
		const address = http.address();
		if (!address || typeof address === "string") throw new Error("Runtime address unavailable");
		const hostname = options.hostname ?? "127.0.0.1";
		return { url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`, close };
	} catch (error) {
		await close();
		throw error;
	}
}
