import type { AddressInfo } from "node:net";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { Express } from "express";
import express from "express";
import { createPunchAgentCard } from "./agent-card.ts";
import { HarnessAgentExecutor, type HarnessPromptRunnerFactory } from "./executor.ts";
import { formatA2aHttpUrl } from "./http-url.ts";

export interface A2aListenAddress {
	host: string;
	port: number;
	url: string;
}

export interface CreateA2aServerOptions {
	baseUrl?: string;
	publicHost?: string;
	runnerFactory: HarnessPromptRunnerFactory;
	name?: string;
	description?: string;
}

export interface A2aServer {
	app: Express;
	requestHandler: DefaultRequestHandler;
	listen(port?: number, host?: string): Promise<A2aListenAddress>;
	close(): Promise<void>;
	address(): A2aListenAddress | undefined;
}

export async function createA2aServer(options: CreateA2aServerOptions): Promise<A2aServer> {
	const taskStore = new InMemoryTaskStore();
	const agentExecutor = new HarnessAgentExecutor(options.runnerFactory);
	const app = express();
	let requestHandler!: DefaultRequestHandler;
	let routesMounted = false;
	let server: ReturnType<Express["listen"]> | undefined;
	let bound: A2aListenAddress | undefined;

	function mount(baseUrl: string): void {
		if (routesMounted) return;
		const agentCard = createPunchAgentCard({
			baseUrl,
			name: options.name,
			description: options.description,
		});
		requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor);
		app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
		app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
		routesMounted = true;
	}

	if (options.baseUrl) mount(options.baseUrl);

	return {
		app,
		get requestHandler() {
			return requestHandler;
		},
		listen(port = 0, host = "127.0.0.1") {
			return new Promise((resolve, reject) => {
				server = app.listen(port, host, (error?: Error) => {
					if (error) {
						reject(error);
						return;
					}
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("A2A server bound without a TCP address"));
						return;
					}
					const info = addr as AddressInfo;
					const url = options.baseUrl ?? formatA2aHttpUrl(options.publicHost ?? info.address, info.port);
					bound = { host: info.address, port: info.port, url };
					try {
						mount(url);
					} catch (err) {
						reject(err);
						return;
					}
					resolve(bound);
				});
			});
		},
		address() {
			return bound;
		},
		close() {
			return new Promise((resolve, reject) => {
				if (!server) {
					bound = undefined;
					resolve();
					return;
				}
				server.close((error) => {
					if (error) reject(error);
					else {
						bound = undefined;
						resolve();
					}
				});
			});
		},
	};
}
