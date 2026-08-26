import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { JsonRpcResponse, McpTransport } from "./mcp-transport.ts";

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpToolResultContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface McpToolResult {
	content?: McpToolResultContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

export class McpClient {
	private readonly transport: McpTransport;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();

	constructor(transport: McpTransport) {
		this.transport = transport;
	}

	async start(): Promise<void> {
		await this.transport.start();
	}

	async listTools(): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const response = await this.request("tools/list", cursor ? { cursor } : {});
			if (response.error) {
				throw new Error(`tools/list failed: ${response.error.message}`);
			}
			const result = response.result as { tools?: McpToolInfo[]; nextCursor?: string };
			for (const tool of result?.tools ?? []) {
				tools.push({
					name: tool.name,
					description: tool.description,
					inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
				});
			}
			cursor = result?.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const response = await this.request("tools/call", { name, arguments: args });
		if (response.error) {
			throw new Error(`tools/call ${name} failed: ${response.error.message}`);
		}
		const result = response.result as McpToolResult | undefined;
		if (result?.isError) {
			const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "MCP tool error";
			throw new Error(text);
		}
		return result ?? {};
	}

	async close(): Promise<void> {
		await this.transport.close();
	}

	private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
		const id = this.nextId++;
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			void this.transport
				.request({ jsonrpc: "2.0", id, method, params })
				.then((response) => {
					this.pending.delete(id);
					resolve(response);
				})
				.catch((err: unknown) => {
					this.pending.delete(id);
					reject(err instanceof Error ? err : new Error(String(err)));
				});
		});
	}
}

export function jsonSchemaToTypeBox(schema: unknown, depth = 0): TSchema {
	if (depth > 8) return Type.Unknown();
	if (!schema || typeof schema !== "object") return Type.Unknown();
	const s = schema as Record<string, unknown>;
	const ref = typeof s.$ref === "string" ? s.$ref : undefined;
	if (ref) throw new Error(`MCP tool schema $ref is not supported: ${ref}`);
	if (Array.isArray(s.enum)) {
		const values = s.enum.filter(
			(v): v is string | number | boolean =>
				typeof v === "string" || typeof v === "number" || typeof v === "boolean",
		);
		if (values.length > 0) {
			return Type.Union(values.map((v) => Type.Literal(v)));
		}
		return Type.Unknown();
	}
	if (s.anyOf && Array.isArray(s.anyOf)) {
		const subs = (s.anyOf as unknown[]).map((x) => jsonSchemaToTypeBox(x, depth + 1));
		return subs.length > 0 ? Type.Union(subs) : Type.Unknown();
	}
	if (s.oneOf && Array.isArray(s.oneOf)) {
		const subs = (s.oneOf as unknown[]).map((x) => jsonSchemaToTypeBox(x, depth + 1));
		return subs.length > 0 ? Type.Union(subs) : Type.Unknown();
	}
	const type = s.type;
	if (type === "string") {
		return Type.String({
			minLength: typeof s.minLength === "number" ? s.minLength : undefined,
			maxLength: typeof s.maxLength === "number" ? s.maxLength : undefined,
		});
	}
	if (type === "integer") {
		return Type.Integer({
			minimum: typeof s.minimum === "number" ? s.minimum : undefined,
			maximum: typeof s.maximum === "number" ? s.maximum : undefined,
		});
	}
	if (type === "number") {
		return Type.Number({
			minimum: typeof s.minimum === "number" ? s.minimum : undefined,
			maximum: typeof s.maximum === "number" ? s.maximum : undefined,
		});
	}
	if (type === "boolean") return Type.Boolean();
	if (type === "null") return Type.Null();
	if (type === "array") {
		const items = s.items as Record<string, unknown> | undefined;
		const itemSchema = items ? jsonSchemaToTypeBox(items, depth + 1) : Type.Unknown();
		if (typeof s.minItems === "number" || typeof s.maxItems === "number") {
			return Type.Array(itemSchema, {
				minItems: typeof s.minItems === "number" ? s.minItems : undefined,
				maxItems: typeof s.maxItems === "number" ? s.maxItems : undefined,
			});
		}
		return Type.Array(itemSchema);
	}
	if (type === "object" || s.properties) {
		const properties = (s.properties ?? {}) as Record<string, unknown>;
		const required = (s.required ?? []) as string[];
		const props: Record<string, TSchema> = {};
		for (const [key, value] of Object.entries(properties)) {
			const ts = jsonSchemaToTypeBox(value, depth + 1);
			props[key] = required.includes(key) ? ts : Type.Optional(ts);
		}
		if (s.additionalProperties === false) {
			return Type.Object(props, { additionalProperties: false });
		}
		if (typeof s.additionalProperties === "object") {
			return Type.Object(props, {
				additionalProperties: jsonSchemaToTypeBox(s.additionalProperties, depth + 1),
			});
		}
		if (s.additionalProperties === true) {
			return Type.Record(Type.String(), Type.Unknown(), { properties: props, required });
		}
		return Type.Object(props);
	}
	if (Array.isArray(type)) {
		const subs = type.map((t) => jsonSchemaToTypeBox({ type: t }, depth + 1));
		return subs.length > 0 ? Type.Union(subs) : Type.Unknown();
	}
	return Type.Unknown();
}
