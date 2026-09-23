import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SandboxRoute, SandboxSupervisor } from "./manager.ts";
import type { SandboxRecord, SandboxRegistry } from "./registry.ts";

export type SandboxSummary = Omit<SandboxRecord, "token">;

export interface SupervisorClient {
	create(workspaceId: string): Promise<SandboxSummary>;
	inspect(sandboxId: string, workspaceId: string): Promise<SandboxSummary>;
	acquire(sandboxId: string, workspaceId: string): Promise<SandboxRoute>;
	stop(sandboxId: string, workspaceId: string): Promise<void>;
	delete(sandboxId: string, workspaceId: string, deleteData: boolean): Promise<void>;
}

/** Private control plane. Its credential grants gateway-level authority, not end-user access. */
export async function startSupervisorControl(options: {
	readonly supervisor: SandboxSupervisor;
	readonly registry: SandboxRegistry;
	readonly token: string;
	readonly hostname?: string;
	readonly port?: number;
	onError(error: unknown): void;
}): Promise<{ url: string; close(): Promise<void> }> {
	if (options.token.length < 32) throw new Error("Supervisor control token is too short");
	const pending = new Set<Promise<void>>();
	let closing = false;
	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
		const expected = Buffer.from(options.token);
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
			response.writeHead(401).end();
			return;
		}
		if (closing) {
			response.writeHead(503).end();
			return;
		}
		if (request.method === "GET" && request.url === "/ready") {
			response.writeHead(200, { "cache-control": "no-store" }).end();
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/sandboxes") {
			response.writeHead(404).end();
			return;
		}
		let length = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += bytes.length;
			if (length > 16_384) {
				response.writeHead(413).end();
				return;
			}
			chunks.push(bytes);
		}
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (
			!body ||
			typeof body !== "object" ||
			!("workspaceId" in body) ||
			typeof body.workspaceId !== "string" ||
			!body.workspaceId.trim() ||
			body.workspaceId.length > 256 ||
			!("action" in body)
		)
			throw new Error("Invalid supervisor request");
		const { workspaceId, action } = body;
		let result: unknown = null;
		if (action === "create") {
			const { token: _token, ...summary } = options.registry.create(workspaceId);
			result = summary;
		} else {
			if (!("sandboxId" in body) || typeof body.sandboxId !== "string" || body.sandboxId.length > 128)
				throw new Error("Invalid sandbox ID");
			const { sandboxId } = body;
			switch (action) {
				case "inspect": {
					const { token: _token, ...summary } = options.registry.get(sandboxId, workspaceId);
					result = summary;
					break;
				}
				case "acquire":
					result = await options.supervisor.acquire(sandboxId, workspaceId);
					break;
				case "stop":
					await options.supervisor.stop(sandboxId, workspaceId);
					break;
				case "delete":
					if (!("deleteData" in body) || typeof body.deleteData !== "boolean")
						throw new Error("Explicit data deletion choice required");
					await options.supervisor.delete(sandboxId, workspaceId, body.deleteData);
					break;
				default:
					throw new Error("Unknown supervisor action");
			}
		}
		response
			.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
			.end(JSON.stringify(result));
	};
	const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
		const operation = handle(request, response).catch((error) => {
			try {
				options.onError(error);
			} catch {
				/* Logging cannot interrupt cleanup. */
			}
			if (!response.headersSent)
				response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(
				JSON.stringify({ error: error instanceof Error ? error.message : "Supervisor operation failed" }),
			);
		});
		pending.add(operation);
		void operation.finally(() => pending.delete(operation));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 8081, options.hostname ?? "127.0.0.1", () => {
			server.off("error", reject);
			server.on("error", (error) => {
				try {
					options.onError(error);
				} catch {}
			});
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Supervisor address unavailable");
	const hostname = options.hostname ?? "127.0.0.1";
	return {
		url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`,
		async close() {
			closing = true;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await Promise.allSettled(pending);
		},
	};
}

export function createSupervisorClient(url: string, token: string): SupervisorClient {
	const endpoint = new URL("/v1/sandboxes", url);
	if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
		throw new Error("Invalid supervisor URL");
	const call = async <T>(body: object): Promise<T> => {
		const response = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const detail =
				body && typeof body === "object" && "error" in body && typeof body.error === "string"
					? `: ${body.error}`
					: "";
			throw new Error(`Supervisor request failed (${response.status})${detail}`);
		}
		return (await response.json()) as T;
	};
	return {
		create: (workspaceId) => call({ action: "create", workspaceId }),
		inspect: (sandboxId, workspaceId) => call({ action: "inspect", sandboxId, workspaceId }),
		acquire: (sandboxId, workspaceId) => call({ action: "acquire", sandboxId, workspaceId }),
		stop: async (sandboxId, workspaceId) => {
			await call({ action: "stop", sandboxId, workspaceId });
		},
		delete: async (sandboxId, workspaceId, deleteData) => {
			await call({ action: "delete", sandboxId, workspaceId, deleteData });
		},
	};
}
