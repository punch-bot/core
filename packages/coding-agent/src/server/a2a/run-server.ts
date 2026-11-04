import { createA2aServer } from "@punch-bot/a2a";
import { createCodingAgentHarnessRunnerFactory } from "./harness-runner.ts";

export interface RunA2aServerOptions {
	baseUrl: string;
	port: number;
	host?: string;
	cwd?: string;
	agentDir?: string;
	name?: string;
	description?: string;
	authToken?: string;
}

export async function runA2aServer(
	options: RunA2aServerOptions,
): Promise<{ authToken: string; close: () => Promise<void> }> {
	const runnerFactory = await createCodingAgentHarnessRunnerFactory({
		cwd: options.cwd,
		agentDir: options.agentDir,
	});
	const server = await createA2aServer({
		baseUrl: options.baseUrl,
		runnerFactory,
		name: options.name,
		description: options.description,
		authToken: options.authToken,
	});
	await server.listen(options.port, options.host ?? "127.0.0.1");
	return {
		authToken: server.authToken,
		close: () => server.close(),
	};
}
