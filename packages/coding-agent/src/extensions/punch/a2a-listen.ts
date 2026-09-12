import { randomUUID } from "node:crypto";

import { createA2aServer, defaultA2aDiscoveryDir, LocalA2aDiscovery } from "@punch-bot/a2a";

import { createCodingAgentHarnessRunnerFactory } from "../../server/a2a/harness-runner.ts";
import { punchSandboxName } from "./a2a.ts";

const HEARTBEAT_MS = 15_000;

interface ProcessA2a {
	discovery: LocalA2aDiscovery;
	close(): Promise<void>;
}

let processA2a: ProcessA2a | undefined;
let processA2aStart: Promise<ProcessA2a | undefined> | undefined;

function parseListenPort(env: NodeJS.ProcessEnv): number {
	if (!env.PUNCH_A2A_PORT) return 0;
	const port = Number(env.PUNCH_A2A_PORT);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid PUNCH_A2A_PORT "${env.PUNCH_A2A_PORT}"`);
	}
	return port;
}

export async function startPunchA2aListener(
	env: NodeJS.ProcessEnv = process.env,
	discovery?: LocalA2aDiscovery,
): Promise<ProcessA2a | undefined> {
	if (processA2a) return processA2a;
	if (processA2aStart) return processA2aStart;
	processA2aStart = (async () => {
		const registry = discovery ?? new LocalA2aDiscovery({ dir: defaultA2aDiscoveryDir(env) });
		const host = env.PUNCH_A2A_HOST || "127.0.0.1";
		const port = parseListenPort(env);
		const name = punchSandboxName(env);
		const advertiseUrl = env.PUNCH_A2A_ADVERTISE_URL?.trim();
		const publicHost = env.PUNCH_A2A_ADVERTISE_HOST?.trim();
		const runnerFactory = await createCodingAgentHarnessRunnerFactory({ cwd: process.cwd() });
		const server = await createA2aServer({
			runnerFactory,
			name,
			description: `Punch sandbox ${name}`,
			...(advertiseUrl ? { baseUrl: advertiseUrl } : {}),
			...(publicHost ? { publicHost } : {}),
		});
		try {
			const bound = await server.listen(port, host);
			const url = advertiseUrl || bound.url;
			registry.advertise({
				id: randomUUID(),
				name,
				url,
				pid: process.pid,
				cwd: process.cwd(),
				startedAt: Date.now(),
			});
			const timer = setInterval(() => {
				registry.heartbeat();
			}, HEARTBEAT_MS);
			timer.unref();
			const close = async () => {
				clearInterval(timer);
				registry.close();
				await server.close();
			};
			const runtime: ProcessA2a = { discovery: registry, close };
			processA2a = runtime;
			process.on("exit", () => {
				registry.close();
			});
			return runtime;
		} catch (err) {
			await server.close().catch(() => undefined);
			throw err;
		}
	})().catch((err) => {
		processA2aStart = undefined;
		console.warn(`punch a2a discovery disabled: ${(err as Error).message}`);
		return undefined;
	});
	return processA2aStart;
}
