import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { Express } from "express";
import express from "express";
import { createPunchAgentCard } from "./agent-card.ts";
import { HarnessAgentExecutor, type HarnessPromptRunnerFactory } from "./executor.ts";

export interface CreateA2aServerOptions {
	baseUrl: string;
	runnerFactory: HarnessPromptRunnerFactory;
	name?: string;
	description?: string;
}

export interface A2aServer {
	app: Express;
	requestHandler: DefaultRequestHandler;
	listen(port: number, host?: string): Promise<void>;
	close(): Promise<void>;
}

export async function createA2aServer(options: CreateA2aServerOptions): Promise<A2aServer> {
	const agentCard = createPunchAgentCard({
		baseUrl: options.baseUrl,
		name: options.name,
		description: options.description,
	});
	const taskStore = new InMemoryTaskStore();
	const agentExecutor = new HarnessAgentExecutor(options.runnerFactory);
	const requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor);
	const app = express();
	app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
	app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

	let server: ReturnType<Express["listen"]> | undefined;
	return {
		app,
		requestHandler,
		listen(port, host = "127.0.0.1") {
			return new Promise((resolve, reject) => {
				server = app.listen(port, host, (error?: Error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
		close() {
			return new Promise((resolve, reject) => {
				if (!server) {
					resolve();
					return;
				}
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
	};
}
