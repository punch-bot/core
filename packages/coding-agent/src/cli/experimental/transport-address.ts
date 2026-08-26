import { posix } from "node:path";

export interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

export interface HttpTransportAddress {
	readonly transport: "http";
	readonly url: string;
	readonly host: string;
	readonly port: number;
}

export type TransportAddress = UnixTransportAddress;

function normalizeListenHost(hostname: string): string {
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return hostname.slice(1, -1);
	}
	return hostname;
}

export function isLoopbackHost(host: string): boolean {
	const normalized = normalizeListenHost(host);
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function parseHttpListenAddress(value: string): { address?: HttpTransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid A2A listen address "${value}"` };
	}
	if (url.protocol !== "http:") {
		return {
			error:
				url.protocol === "https:"
					? `HTTPS A2A listen is not supported yet: "${value}"`
					: `Unsupported A2A listen transport "${url.protocol}"`,
		};
	}
	if (!url.hostname) {
		return { error: `Invalid A2A listen address "${value}"` };
	}
	if (url.username || url.password) {
		return { error: `A2A listen address must not include credentials: "${value}"` };
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		return { error: `A2A listen address must not include a path: "${value}"` };
	}
	if (url.search || url.hash) {
		return { error: `A2A listen address must not include query or fragment: "${value}"` };
	}
	const port = url.port ? Number(url.port) : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		return { error: `Invalid A2A listen port in "${value}"` };
	}
	const host = normalizeListenHost(url.hostname);
	return {
		address: {
			transport: "http",
			url: `${url.origin}/`,
			host,
			port,
		},
	};
}

export function parseTransportAddress(
	value: string,
	option: "--listen" | "--connect",
): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (url.protocol !== "unix:") {
		return { error: `Unsupported ${option} transport "${url.protocol}"` };
	}
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (path.includes("\0")) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (!posix.isAbsolute(path)) {
		return { error: "Unix transport address requires an absolute path" };
	}
	return { address: { transport: "unix", path } };
}
