import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { Express, NextFunction, Request, Response } from "express";
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
	/** Bearer token callers must send. A random token is generated when omitted. */
	authToken?: string;
}

export interface A2aServer {
	app: Express;
	requestHandler: DefaultRequestHandler | undefined;
	/** Bearer token required on every request. Pass it to clients as `token`. */
	readonly authToken: string;
	listen(port?: number, host?: string): Promise<A2aListenAddress>;
	close(): Promise<void>;
	address(): A2aListenAddress | undefined;
	unref(): void;
}

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

function isLoopbackHost(host: string): boolean {
	const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (hostname === "localhost" || hostname === "::1") return true;
	return isIP(hostname) === 4 && hostname.startsWith("127.");
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function bearerToken(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}

function urlHost(url: string): string {
	return new URL(url).host.toLowerCase();
}

export async function createA2aServer(options: CreateA2aServerOptions): Promise<A2aServer> {
	const authToken = options.authToken ?? randomBytes(32).toString("base64url");
	if (authToken.trim().length === 0) throw new Error("A2A authToken must not be empty.");
	const expectedDigest = digest(authToken);
	const taskStore = new InMemoryTaskStore();
	const agentExecutor = new HarnessAgentExecutor(options.runnerFactory);
	const app = express();
	let requestHandler: DefaultRequestHandler | undefined;
	let routesMounted = false;
	let server: ReturnType<Express["listen"]> | undefined;
	let bound: A2aListenAddress | undefined;
	let allowedHosts = new Set<string>();

	function computeAllowedHosts(info: A2aListenAddress): Set<string> {
		const hosts = new Set<string>();
		const port = info.port;
		const boundHost = info.host.includes(":") ? `[${info.host}]` : info.host;
		hosts.add(`${boundHost}:${port}`.toLowerCase());
		if (isLoopbackHost(info.host) || info.host === "0.0.0.0" || info.host === "::") {
			for (const name of LOOPBACK_NAMES) hosts.add(`${name}:${port}`);
		}
		hosts.add(urlHost(info.url));
		if (options.baseUrl) hosts.add(urlHost(options.baseUrl));
		if (options.publicHost) hosts.add(urlHost(formatA2aHttpUrl(options.publicHost, port)));
		return hosts;
	}

	app.use((req: Request, res: Response, next: NextFunction) => {
		const host = req.headers.host?.toLowerCase();
		if (!bound || !host || !allowedHosts.has(host)) {
			res.status(403).json({ error: "Forbidden host" });
			return;
		}
		const token = bearerToken(req.headers.authorization);
		if (!token || !timingSafeEqual(digest(token), expectedDigest)) {
			res.setHeader("WWW-Authenticate", 'Bearer realm="a2a"');
			res.status(401).json({ error: "Unauthorized" });
			return;
		}
		next();
	});

	function mount(baseUrl: string): void {
		if (routesMounted) return;
		const agentCard = createPunchAgentCard({
			baseUrl,
			name: options.name,
			description: options.description,
		});
		requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor);
		app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
		// Authentication is enforced by the bearer-token middleware above.
		app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
		routesMounted = true;
	}

	if (options.baseUrl) mount(options.baseUrl);

	return {
		app,
		get requestHandler() {
			return requestHandler;
		},
		authToken,
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
					const next = { host: info.address, port: info.port, url };
					try {
						allowedHosts = computeAllowedHosts(next);
						mount(url);
					} catch (err) {
						reject(err);
						return;
					}
					bound = next;
					resolve(bound);
				});
			});
		},
		address() {
			return bound;
		},
		unref() {
			server?.unref();
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
