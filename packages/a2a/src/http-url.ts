export function formatA2aHttpUrl(host: string, port: number): string {
	let hostname = host;
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		hostname = hostname.slice(1, -1);
	}
	if (hostname === "0.0.0.0" || hostname === "::" || hostname === "") {
		hostname = "127.0.0.1";
	}
	const wrapped = hostname.includes(":") ? `[${hostname}]` : hostname;
	return `http://${wrapped}:${port}/`;
}
