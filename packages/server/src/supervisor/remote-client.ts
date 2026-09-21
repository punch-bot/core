import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { Client } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { getPrincipal, type Principal, withPrincipal } from "../principal.ts";
import { signRuntimeCapability } from "./capability.ts";
import type { SandboxRoute } from "./manager.ts";

export function connectSandboxRuntime(route: SandboxRoute, principal: Principal): Promise<Client> {
	const identity = getPrincipal(withPrincipal(principal, BACKGROUND_CONTEXT))!;
	const url = new URL("/punch", route.url);
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
		throw new Error("Invalid runtime route");
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return Client.connect({
		serverId: route.sandboxId,
		transportFactory: createWebSocketTransportFactory({
			url: url.toString(),
			async getAccessToken() {
				return signRuntimeCapability(route.token, route.generation, identity);
			},
		}),
	});
}
