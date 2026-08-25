import { Buffer } from "node:buffer";

export type McpRegistry = Record<string, McpRegistryEntry>;

export interface McpRegistryEntry {
	type?: "local" | "remote";
	enabled?: boolean;
	command?: string | string[];
	environment?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	auth?: string;
	apiKey?: boolean;
	apiKeyEnv?: string;
	apiKeyHeader?: string;
}

export interface McpAdapterEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	auth?: false | "bearer";
	bearerTokenEnv?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
}

export interface McpAdapterConfig {
	mcpServers: Record<string, McpAdapterEntry>;
	settings?: { autoAuth?: boolean; hostConfigDiscovery?: string };
}

const API_KEY_SUFFIX = "_API_KEY";
const MCP_PREFIX = "MCP_";

export function legacyMcpApiKeyEnvVar(serverName: string): string {
	const safe = (serverName || "")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${MCP_PREFIX}${safe || "SERVER"}${API_KEY_SUFFIX}`;
}

export function mcpApiKeyEnvVar(serverName: string): string {
	if (!serverName) return `${MCP_PREFIX}SERVER${API_KEY_SUFFIX}`;
	return `${MCP_PREFIX}${Buffer.from(serverName).toString("base64url")}${API_KEY_SUFFIX}`;
}

export function mcpApiKeyEnvVarCandidates(serverName: string): string[] {
	const candidates = [mcpApiKeyEnvVar(serverName)];
	const legacy = legacyMcpApiKeyEnvVar(serverName);
	if (!candidates.includes(legacy)) candidates.push(legacy);
	return candidates;
}

function splitCommandString(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaping = false;
	for (const ch of input) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (quote) throw new Error("unterminated quote in command");
	if (current) parts.push(current);
	return parts;
}

function asStringRecord(value: unknown, label: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (typeof val !== "string") throw new Error(`${label}.${key} must be a string`);
		out[key] = val;
	}
	return out;
}

function normalizeLocalCommand(command: string | string[] | undefined): string[] {
	if (command === undefined) throw new Error("local MCP server requires a command");
	const parts = typeof command === "string" ? splitCommandString(command) : command;
	if (!Array.isArray(parts) || parts.length === 0 || parts.some((p) => typeof p !== "string" || p === "")) {
		throw new Error("local MCP server command must be a non-empty command");
	}
	return parts;
}

export function usesApiKeyAuth(entry: McpRegistryEntry): boolean {
	return entry.auth === "api_key" || entry.auth === "apikey" || entry.apiKey === true;
}

function legacyMcpApiKeyOwners(registry: McpRegistry): Map<string, string[]> {
	const owners = new Map<string, string[]>();
	for (const [name, entry] of Object.entries(registry)) {
		if (!usesApiKeyAuth(entry)) continue;
		const legacy = legacyMcpApiKeyEnvVar(name);
		const modern = mcpApiKeyEnvVar(name);
		if (legacy !== modern) owners.set(legacy, [...(owners.get(legacy) ?? []), name]);
	}
	return owners;
}

export function migrateMcpApiKeyEnvVars(
	registry: McpRegistry,
	env: Record<string, string | undefined>,
): { env: Record<string, string | undefined>; changed: boolean } {
	const out = { ...env };
	let changed = false;
	for (const [name, entry] of Object.entries(registry)) {
		if (!usesApiKeyAuth(entry)) continue;
		const legacy = legacyMcpApiKeyEnvVar(name);
		const modern = mcpApiKeyEnvVar(name);
		if (legacy === modern) continue;
		if (out[modern] !== undefined) continue;
		const owners = legacyMcpApiKeyOwners(registry).get(legacy) ?? [];
		if (owners.length === 1 && out[legacy] !== undefined) {
			out[modern] = out[legacy];
			delete out[legacy];
			changed = true;
		}
	}
	return { env: out, changed };
}

export function redactMcpKeysFromEnvView(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const out = { ...env };
	for (const key of Object.keys(out)) {
		if (key.startsWith(MCP_PREFIX) && key.endsWith(API_KEY_SUFFIX) && out[key]) out[key] = "(set)";
	}
	return out;
}

export function isMcpApiKeyConfigured(
	env: Record<string, string | undefined>,
	serverName: string,
	registry: McpRegistry,
): boolean {
	const entry = registry[serverName];
	if (!usesApiKeyAuth(entry)) return true;
	return mcpApiKeyEnvVarCandidates(serverName).some((v) => env[v] !== undefined && env[v] !== "");
}

export function sanitizeMcpEntryForDisplay(entry: McpRegistryEntry): Record<string, unknown> {
	const out: Record<string, unknown> = { ...entry };
	if (out.headers && typeof out.headers === "object") {
		out.headers = Object.fromEntries(Object.keys(out.headers as Record<string, unknown>).map((k) => [k, "(set)"]));
	}
	delete out.apiKey;
	delete out.apiKeyEnv;
	return out;
}

export function assertPunchEntry(entry: McpRegistryEntry | undefined): McpAdapterEntry | null {
	if (!entry || typeof entry !== "object") throw new Error("MCP server entry must be an object");
	const enabled = entry.enabled !== false;
	const auth = entry.auth;
	if (auth !== undefined && auth !== "api_key" && auth !== "apikey") throw new Error("auth must be api_key");
	if (entry.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv)) {
		throw new Error("apiKeyEnv must be a valid environment variable name");
	}
	if (entry.apiKeyHeader !== undefined && entry.apiKeyHeader === "") throw new Error("apiKeyHeader must be non-empty");

	if (entry.type === "remote") {
		if (!entry.url) throw new Error("remote MCP server requires url");
		let parsed: URL;
		try {
			parsed = new URL(entry.url);
		} catch {
			throw new Error("remote MCP server url must be parseable");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			throw new Error("remote MCP server url must be http(s)");
		const hasCredentials =
			entry.auth === "api_key" ||
			entry.apiKey === true ||
			(entry.headers !== undefined && Object.keys(entry.headers).length > 0);
		if (hasCredentials && parsed.protocol !== "https:")
			throw new Error("remote MCP server with credentials requires https");
		const out: McpAdapterEntry = { url: entry.url, disabled: !enabled };
		if (entry.auth === "api_key" || entry.apiKey === true) out.auth = "bearer";
		if (entry.headers !== undefined) out.headers = asStringRecord(entry.headers, "headers");
		return out;
	}

	const command = normalizeLocalCommand(entry.command);
	const out: McpAdapterEntry = { command: command[0], args: command.slice(1), disabled: !enabled };
	if (entry.auth === "api_key" || entry.apiKey === true) out.auth = "bearer";
	if (entry.environment !== undefined) out.env = asStringRecord(entry.environment, "environment");
	return out;
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		if (lower === "authorization" || lower === "x-api-key" || lower.endsWith("-api-key") || lower.includes("token"))
			continue;
		out[key] = value;
	}
	return out;
}

export function applyApiKeyAuthToAdapter(out: McpAdapterEntry, entry: McpRegistryEntry, serverName: string): void {
	if (!usesApiKeyAuth(entry)) return;
	const envVar = mcpApiKeyEnvVar(serverName);
	const ref = `\${${envVar}}`;
	if (out.headers) {
		const stripped = stripCredentialHeaders(out.headers);
		const apiKeyHeader = entry.apiKeyHeader;
		if (apiKeyHeader && apiKeyHeader.toLowerCase() !== "authorization") {
			out.headers = { ...stripped, [apiKeyHeader]: ref };
			return;
		}
		out.headers = stripped;
	}
	out.auth = "bearer";
	out.bearerTokenEnv = envVar;
}

export function punchEntryToAdapter(entry: McpRegistryEntry | undefined, serverName: string): McpAdapterEntry | null {
	let out: McpAdapterEntry | null;
	try {
		out = assertPunchEntry(entry);
	} catch {
		return null;
	}
	if (!out) return null;
	applyApiKeyAuthToAdapter(out, entry!, serverName);
	return out;
}

export function punchRegistryToMcpServers(registry: McpRegistry | undefined): Record<string, McpAdapterEntry> {
	if (!registry || typeof registry !== "object") return {};
	const out: Record<string, McpAdapterEntry> = {};
	for (const [name, entry] of Object.entries(registry)) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
		const adapter = punchEntryToAdapter(entry, name);
		if (adapter) out[name] = adapter;
	}
	return out;
}

export function punchRegistryToAdapterConfig(registry: McpRegistry | undefined): McpAdapterConfig {
	return {
		mcpServers: punchRegistryToMcpServers(registry),
		settings: { autoAuth: false, hostConfigDiscovery: "off" },
	};
}
