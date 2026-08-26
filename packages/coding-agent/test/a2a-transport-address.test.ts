import { describe, expect, test } from "vitest";
import { isLoopbackHost, parseHttpListenAddress } from "../src/cli/experimental/transport-address.ts";

describe("parseHttpListenAddress", () => {
	test("parses http listen addresses", () => {
		expect(parseHttpListenAddress("http://127.0.0.1:41241")).toEqual({
			address: {
				transport: "http",
				url: "http://127.0.0.1:41241/",
				host: "127.0.0.1",
				port: 41241,
			},
		});
	});

	test("normalizes IPv6 listen hosts", () => {
		expect(parseHttpListenAddress("http://[::1]:41241")).toEqual({
			address: {
				transport: "http",
				url: "http://[::1]:41241/",
				host: "::1",
				port: 41241,
			},
		});
	});

	test("rejects https listen addresses", () => {
		expect(parseHttpListenAddress("https://127.0.0.1:41241")).toEqual({
			error: 'HTTPS A2A listen is not supported yet: "https://127.0.0.1:41241"',
		});
	});

	test("rejects unsupported transports", () => {
		expect(parseHttpListenAddress("unix:///tmp/pi.sock")).toEqual({
			error: 'Unsupported A2A listen transport "unix:"',
		});
	});

	test("rejects path, query, and fragment components", () => {
		expect(parseHttpListenAddress("http://127.0.0.1:41241/a2a")).toEqual({
			error: 'A2A listen address must not include a path: "http://127.0.0.1:41241/a2a"',
		});
		expect(parseHttpListenAddress("http://127.0.0.1:41241?tls=1")).toEqual({
			error: 'A2A listen address must not include query or fragment: "http://127.0.0.1:41241?tls=1"',
		});
	});
});

describe("isLoopbackHost", () => {
	test("accepts common loopback hosts", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
	});
});
