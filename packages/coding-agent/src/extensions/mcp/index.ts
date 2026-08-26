import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { type TSchema, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { jsonSchemaToTypeBox, McpClient } from "./mcp-client.ts";
import { type McpAdapterEntry, type McpRegistry, punchRegistryToMcpServers } from "./mcp-config.ts";
import { type McpTransport, StdioMcpTransport, StreamableHttpMcpTransport } from "./mcp-transport.ts";

const clients: McpClient[] = [];
let extensionGeneration = 0;

function trackClient(client: McpClient): void {
	clients.push(client);
}

function closeClients(): void {
	extensionGeneration++;
	for (const client of clients) {
		void client.close();
	}
	clients.length = 0;
}

function resolveEnvRef(value: string): string | undefined {
	const match = /^\$\{([^}]+)\}$/.exec(value);
	if (!match) return undefined;
	return process.env[match[1]];
}

function buildTransport(entry: McpAdapterEntry): McpTransport {
	if (entry.url) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(entry.headers ?? {})) {
			headers[key] = resolveEnvRef(value) ?? value;
		}
		if (entry.bearerTokenEnv) {
			const token = process.env[entry.bearerTokenEnv];
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		return new StreamableHttpMcpTransport({ url: entry.url, headers });
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.env ?? {})) {
		env[key] = resolveEnvRef(value) ?? value;
	}
	if (entry.bearerTokenEnv) {
		const token = process.env[entry.bearerTokenEnv];
		if (token) env.API_KEY = token;
	}
	return new StdioMcpTransport({
		command: entry.command ?? "",
		args: entry.args ?? [],
		env,
		cwd: process.cwd(),
	});
}

async function registerMcpServer(
	pi: ExtensionAPI,
	name: string,
	entry: McpAdapterEntry,
	generation: number,
): Promise<void> {
	if (entry.disabled) return;
	const client = new McpClient(buildTransport(entry));
	trackClient(client);
	let tools: Awaited<ReturnType<McpClient["listTools"]>>;
	try {
		await client.start();
		if (generation !== extensionGeneration) {
			void client.close();
			return;
		}
		tools = await client.listTools();
		if (generation !== extensionGeneration) {
			void client.close();
			return;
		}
		} catch (err) {
			void client.close();
			if (generation !== extensionGeneration) return;
			pi.sendUserMessage(`mcp: failed to connect to server "${name}": ${(err as Error).message}`);
			return;
	for (const tool of tools) {
		const toolName = `mcp__${name}__${tool.name}`;
		let parameters: TSchema;
		try {
			parameters = jsonSchemaToTypeBox(tool.inputSchema);
		} catch {
			parameters = Type.Object({});
		}
		pi.registerTool({
			name: toolName,
			label: tool.name,
			description: tool.description ?? `MCP tool from server ${name}`,
			parameters,
			async execute(
				_toolCallId: string,
				args: Record<string, unknown>,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				_ctx: ExtensionContext,
			): Promise<{
				content: { type: "text"; text: string }[] | { type: "image"; data: string; mimeType: string }[];
				details: Record<string, unknown>;
				isError?: boolean;
			}> {
				try {
					const result = await client.callTool(tool.name, args);
					const text =
						result.content
							?.map((c) => c.text ?? "")
							.filter(Boolean)
							.join("\n") ?? "";
					const images = result.content
						?.filter(
							(c): c is { type: "image"; data: string; mimeType: string } =>
								c.type === "image" && typeof c.data === "string",
						)
						.map((c) => ({ type: "image" as const, data: c.data, mimeType: c.mimeType ?? "image/png" }));
					const content =
						images && images.length > 0 ? images : [{ type: "text" as const, text: text || "(no text output)" }];
					return {
						content,
						details: { server: name, tool: tool.name },
						...(result.isError === true ? { isError: true } : {}),
					};
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error calling MCP tool ${name}.${tool.name}: ${(err as Error).message}` },
						],
						details: { server: name, tool: tool.name, error: (err as Error).message },
						isError: true,
					};
				}
			},
		});
	}
}

export default function mcpExtension(pi: ExtensionAPI): void {
	const generation = ++extensionGeneration;
	const configPath = process.env.PI_MCP_FILE || path.join(process.cwd(), ".pi", "mcp.json");
	void readFile(configPath, "utf8")
		.then((raw) => {
			if (generation !== extensionGeneration) return;
			const registry = JSON.parse(raw) as McpRegistry;
			const servers = punchRegistryToMcpServers(registry);
			for (const [name, entry] of Object.entries(servers)) {
				void registerMcpServer(pi, name, entry, generation);
			}
		})
		.catch((err: unknown) => {
			if (generation !== extensionGeneration) return;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				pi.sendUserMessage(`mcp: failed to load ${configPath}: ${(err as Error).message}`);
			}
		});
	pi.on("session_shutdown", () => {
		closeClients();
	});
}
