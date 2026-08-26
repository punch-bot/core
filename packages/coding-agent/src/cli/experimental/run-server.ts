import { runA2aServer } from "../../server/a2a/run-server.ts";
import type { ServerCommand } from "./commands/server.ts";
import { isLoopbackHost } from "./transport-address.ts";

export async function runExperimentalServer(command: ServerCommand): Promise<void> {
	if (!command.a2aListen) {
		throw new Error(
			"No server transport configured. Pass --a2a-listen http://127.0.0.1:41241 to start an A2A server.",
		);
	}
	const { host, port, url } = command.a2aListen;
	if (!isLoopbackHost(host) && command.auth === undefined) {
		throw new Error(
			"A2A server currently supports only loopback binds without authentication. Use 127.0.0.1, localhost, or ::1, or pass --auth-token.",
		);
	}
	const server = await runA2aServer({
		baseUrl: url,
		host,
		port,
	});
	process.stdout.write(`A2A server listening on ${url}\n`);
	const shutdown = async () => {
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
	await new Promise<void>(() => {});
}
