import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface McpTransport {
	start(): Promise<void>;
	request(message: JsonRpcRequest): Promise<JsonRpcResponse>;
	close(): Promise<void>;
}

export interface StdioMcpTransportOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

export class StdioMcpTransport implements McpTransport {
	private readonly command: string;
	private readonly args: string[];
	private readonly env: Record<string, string>;
	private readonly cwd: string;
	private child?: ReturnType<typeof spawn>;
	private pending = new Map<number | string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private closed = false;

	constructor(options: StdioMcpTransportOptions) {
		this.command = options.command;
		this.args = options.args ?? [];
		this.env = options.env ?? {};
		this.cwd = options.cwd ?? process.cwd();
	}

	async start(): Promise<void> {
		const childEnv: Record<string, string> = {};
		for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
			const value = process.env[key];
			if (value !== undefined) childEnv[key] = value;
		}
		const child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: { ...childEnv, ...this.env },
			stdio: ["pipe", "pipe", "inherit"],
		});
		this.child = child;
		child.on("error", (err) => {
			this.rejectAll(err);
		});
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			const response = msg as JsonRpcResponse;
			if (response && response.id !== null && typeof response.id !== "undefined") {
				const pending = this.pending.get(response.id);
				if (pending) {
					this.pending.delete(response.id);
					pending.resolve(response);
				}
			}
		});
		child.on("exit", (code, signal) => {
			this.closed = true;
			this.rejectAll(new Error(`MCP server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
		});
		await this.initializeHandshake();
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) pending.reject(error);
		this.pending.clear();
	}

	private async initializeHandshake(): Promise<void> {
		const initResponse = await this.rawRequest({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "initialize",
			params: {
				protocolVersion: DEFAULT_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi", version: "0.84.2" },
			},
		});
		if (initResponse.error) {
			throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
		}
		const stdin = this.child?.stdin;
		if (stdin?.writable) {
			stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
		}
	}

	request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
		return this.rawRequest(message);
	}

	private rawRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
		const stdin = this.child?.stdin;
		if (this.closed || !this.child || !stdin || !stdin.writable) {
			return Promise.reject(new Error("MCP server is not running"));
		}
		return new Promise((resolve, reject) => {
			this.pending.set(message.id, { resolve, reject });
			stdin.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err) {
					this.pending.delete(message.id);
					reject(err);
				}
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		try {
			child.stdin?.end();
		} catch {}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
		await new Promise<void>((resolve) => {
			child.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			if (child.exitCode !== null || child.signalCode !== null) {
				clearTimeout(timeout);
				resolve();
			}
		});
	}
}

export interface StreamableHttpMcpTransportOptions {
	url: string;
	headers?: Record<string, string>;
	apiKeyEnv?: string;
}

export class StreamableHttpMcpTransport implements McpTransport {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private nextId = 1;
	private mcpSessionId?: string;
	private closed = false;

	constructor(options: StreamableHttpMcpTransportOptions) {
		this.url = options.url;
		this.headers = { ...(options.headers ?? {}) };
		const apiKey = options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined;
		if (apiKey) {
			this.headers.Authorization = `Bearer ${apiKey}`;
		}
	}

	async start(): Promise<void> {
		const initResponse = await this.rawRequest({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "initialize",
			params: {
				protocolVersion: DEFAULT_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi", version: "0.84.2" },
			},
		});
		if (initResponse.error) {
			throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
		}
		const result = initResponse.result as Record<string, unknown> | undefined;
		const sessionHeader = result?.["mcp-session-id"] as string | undefined;
		if (sessionHeader) this.mcpSessionId = sessionHeader;
		await this.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
	}

	private async sendNotification(message: { jsonrpc: "2.0"; method: string; params?: unknown }): Promise<void> {
		if (this.closed) return;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.mcpSessionId) headers["Mcp-Session-Id"] = this.mcpSessionId;
		let response: Response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(120_000),
			});
		} catch (err) {
			throw new Error(`MCP HTTP notification failed: ${(err as Error).message}`);
		}
		if (!response.ok) {
			throw new Error(`MCP HTTP notification failed: ${response.status} ${response.statusText}`);
		}
	}

	request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
		return this.rawRequest(message);
	}

	private async rawRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
		if (this.closed) return Promise.reject(new Error("MCP server is not running"));
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.mcpSessionId) headers["Mcp-Session-Id"] = this.mcpSessionId;
		let response: Response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(120_000),
			});
		} catch (err) {
			throw new Error(`MCP HTTP request failed: ${(err as Error).message}`);
		}
		if (!response.ok) {
			throw new Error(`MCP HTTP request failed: ${response.status} ${response.statusText}`);
		}
		const sessionHeader = response.headers.get("mcp-session-id");
		if (sessionHeader) this.mcpSessionId = sessionHeader;
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			const body = await response.text();
			const messages = this.parseSse(body);
			for (const msg of messages) {
				const parsed = msg as JsonRpcResponse;
				if (parsed && parsed.id === message.id) {
					return parsed;
				}
			}
			throw new Error(`MCP SSE response closed without a reply for request id ${message.id}`);
		}
		const text = await response.text();
		if (!text) {
			return { jsonrpc: "2.0", id: message.id, result: {} };
		}
		return JSON.parse(text) as JsonRpcResponse;
	}

	private parseSse(body: string): unknown[] {
		const messages: unknown[] = [];
		let dataLines: string[] = [];
		for (const rawLine of body.split("\n")) {
			const line = rawLine.replace(/\r$/, "");
			if (line === "") {
				if (dataLines.length > 0) {
					const payload = dataLines.join("\n");
					dataLines = [];
					try {
						messages.push(JSON.parse(payload));
					} catch {}
				}
				continue;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5));
			}
		}
		if (dataLines.length > 0) {
			const payload = dataLines.join("\n");
			try {
				messages.push(JSON.parse(payload));
			} catch {}
		}
		return messages;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
