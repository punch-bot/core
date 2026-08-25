import { describe, expect, test } from "vitest";
import { parseHttpListenAddress } from "../src/cli/experimental/transport-address.ts";

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

	test("rejects unsupported transports", () => {
		expect(parseHttpListenAddress("unix:///tmp/pi.sock")).toEqual({
			error: 'Unsupported A2A listen transport "unix:"',
		});
	});
});
