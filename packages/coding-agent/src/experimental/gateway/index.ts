import type { Server as HttpServer } from "node:http";
import { createWebSocketListener, type WebSocketListenerOptions } from "@punch-bot/server/websocket";
import { type StartServerOptions, startServer } from "../server.ts";
import { Gateway, type PlatformAdapter } from "./runtime.ts";
import { GatewayStore } from "./store.ts";

export * from "./auth.ts";
export * from "./discord.ts";
export * from "./runtime.ts";
export * from "./store.ts";

export interface StartGatewayOptions {
	readonly backend?: Omit<StartServerOptions, "sessionAccess">;
	readonly databasePath: string;
	/** The caller owns TLS, HTTP listening and routing DiscordAdapter.handle(). */
	readonly httpServer: HttpServer;
	readonly websocket: Omit<WebSocketListenerOptions, "server">;
	readonly adapters?: readonly PlatformAdapter[];
	/** Explicitly allow trusted local Unix clients to administer all Sessions. Default false. */
	readonly allowLocal?: boolean;
	onError(error: unknown): void;
}

export async function startGateway(options: StartGatewayOptions): Promise<{
	readonly gateway: Gateway;
	readonly serverId: string;
	close(): Promise<void>;
}> {
	const listener = createWebSocketListener({ ...options.websocket, server: options.httpServer });
	const store = new GatewayStore(options.databasePath, { allowLocal: options.allowLocal });
	let backend: Awaited<ReturnType<typeof startServer>> | undefined;
	let gateway: Gateway | undefined;
	const adapters: PlatformAdapter[] = [];
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			const results = await Promise.allSettled([
				Promise.resolve().then(() => listener.close()),
				...adapters.map((adapter) => Promise.resolve().then(() => adapter.stop())),
				Promise.resolve().then(() => gateway?.close()),
			]);
			const backendResult = await Promise.allSettled([Promise.resolve().then(() => backend?.close())]);
			store.close();
			const errors = [...results, ...backendResult].flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (errors.length) throw new AggregateError(errors, "Gateway shutdown failed");
		})();
		return closing;
	};
	try {
		backend = await startServer({ ...options.backend, sessionAccess: store, keepAlive: true });
		gateway = new Gateway({ server: backend.server, store, onError: options.onError });
		const server = backend.server;
		await listener.start((connection, context) => server.accept(connection, context));
		for (const adapter of options.adapters ?? []) {
			adapters.push(adapter);
			await adapter.start(gateway);
		}
		void backend.closed
			.then(close, async (error: unknown) => {
				try {
					options.onError(error);
				} finally {
					await close();
				}
			})
			.catch((error: unknown) => {
				try {
					options.onError(error);
				} catch {
					/* Shutdown is already complete. */
				}
			});
		return { gateway, serverId: backend.serverId, close };
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Gateway startup failed");
		}
		throw error;
	}
}
