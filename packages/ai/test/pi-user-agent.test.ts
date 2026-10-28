import { release } from "node:os";
import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("getPiUserAgent", () => {
	it("does not expose the host kernel version or CPU architecture", () => {
		const userAgent = getPiUserAgent();

		expect(userAgent).toBe("punch-agent");
		expect(userAgent).not.toContain(release());
	});
});
