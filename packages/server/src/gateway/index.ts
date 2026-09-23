import type { Server as HttpServer } from "node:http";
import type { Context } from "@punch-bot/agent";
import { isServerId } from "@punch-bot/protocol";
import { Server } from "../server.ts";
import type { SupervisorClient } from "../supervisor/control.ts";
import { createSandboxGatewayHost } from "../supervisor/gateway-host.ts";
import { createWebSocketListener, type WebSocketListenerOptions } from "../websocket.ts";
import { Gateway } from "./runtime.ts";
import { GatewayStore } from "./store.ts";
import type { PlatformAdapter } from "./types.ts";

export { createOidcAuthenticator } from "./auth.ts";
export { DISCORD_COMMAND, DiscordAdapter } from "./discord.ts";
export { Gateway } from "./runtime.ts";
export { GatewayStore } from "./store.ts";
export type { GatewayCommand, GatewayPresentation, PlatformAdapter, Presentation } from "./types.ts";

/** The caller owns HTTP listening and TLS termination. */
export async function startGateway(options: {
	readonly serverId: string;
	readonly databasePath: string;
	readonly supervisor: SupervisorClient;
	readonly authorizePrincipal?: (context: Context) => Promise<void>;
	readonly httpServer: HttpServer;
	readonly websocket: Omit<WebSocketListenerOptions, "server">;
	readonly adapters?: readonly PlatformAdapter[];
	onError(error: unknown): void;
}): Promise<{ gateway: Gateway; serverId: string; close(): Promise<void> }> {
	if (!isServerId(options.serverId)) throw new Error("Gateway ID must be a UUIDv4");
	const listener = createWebSocketListener({ ...options.websocket, server: options.httpServer });
	const host = createSandboxGatewayHost({ ...options, onSessionRemoved: (id, context) => store.removed(id, context) });
	let store: GatewayStore;
	try {
		store = new GatewayStore(options.databasePath);
	} catch (error) {
		await host.close();
		throw error;
	}
	const server = new Server(host.host, {
		serverId: options.serverId,
		listeners: [listener],
		onError: options.onError,
	});
	const gateway = new Gateway({ server, store, onError: options.onError });
	const adapters: PlatformAdapter[] = [];
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			const results = await Promise.allSettled([
				listener.close(),
				gateway.close(),
				...adapters.map((adapter) => adapter.stop()),
			]);
			results.push(...(await Promise.allSettled([server.close()])));
			results.push(...(await Promise.allSettled([host.close()])));
			store.close();
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "Gateway shutdown failed");
		})();
		return closing;
	};
	try {
		await server.start();
		for (const adapter of options.adapters ?? []) {
			adapters.push(adapter);
			await adapter.start(gateway);
		}
		return { gateway, serverId: server.serverId, close };
	} catch (error) {
		try {
			await close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Gateway startup failed");
		}
		throw error;
	}
}
