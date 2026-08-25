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

export function parseHttpListenAddress(value: string): { address?: HttpTransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid A2A listen address "${value}"` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: `Unsupported A2A listen transport "${url.protocol}"` };
	}
	if (!url.hostname) {
		return { error: `Invalid A2A listen address "${value}"` };
	}
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		return { error: `Invalid A2A listen port in "${value}"` };
	}
	return {
		address: {
			transport: "http",
			url: value.endsWith("/") ? value : `${value}/`,
			host: url.hostname,
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
