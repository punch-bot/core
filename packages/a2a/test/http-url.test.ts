import { describe, expect, test } from "vitest";
import { formatA2aHttpUrl } from "../src/http-url.ts";

describe("formatA2aHttpUrl", () => {
	test("wraps IPv6 hosts and maps wildcards to loopback", () => {
		expect(formatA2aHttpUrl("127.0.0.1", 41241)).toBe("http://127.0.0.1:41241/");
		expect(formatA2aHttpUrl("0.0.0.0", 9)).toBe("http://127.0.0.1:9/");
		expect(formatA2aHttpUrl("::1", 80)).toBe("http://[::1]:80/");
		expect(formatA2aHttpUrl("[::]", 81)).toBe("http://127.0.0.1:81/");
	});
});
