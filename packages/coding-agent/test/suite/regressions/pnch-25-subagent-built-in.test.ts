import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../../../src/extensions/subagent/agents.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("PNCH-25: built-in subagent", () => {
	it("registers the extension through the built-in loading path", () => {
		const registry = readFileSync(join(import.meta.dirname, "../../../src/extensions/index.ts"), "utf8");
		expect(registry).toContain('import subagentExtension from "./subagent/index.ts"');
		expect(registry).toContain('{ name: "subagent", factory: subagentExtension }');
	});

	it("ships sample agents and preserves scope override ordering", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-built-in-"));
		try {
			process.env.PI_CODING_AGENT_DIR = join(tempDir, "user");
			const userAgentsDir = join(tempDir, "user", "agents");
			const projectAgentsDir = join(tempDir, ".pi", "agents");
			mkdirSync(userAgentsDir, { recursive: true });
			mkdirSync(projectAgentsDir, { recursive: true });
			writeFileSync(
				join(userAgentsDir, "scout.md"),
				"---\nname: scout\ndescription: User scout\n---\nUser instructions.\n",
			);
			writeFileSync(
				join(projectAgentsDir, "scout.md"),
				"---\nname: scout\ndescription: Project scout\n---\nProject instructions.\n",
			);

			const userDiscovery = discoverAgents(tempDir, "user");
			expect(userDiscovery.agents.map((agent) => agent.name)).toEqual(
				expect.arrayContaining(["scout", "planner", "reviewer", "worker"]),
			);
			expect(userDiscovery.agents.find((agent) => agent.name === "scout")?.source).toBe("user");

			const bothDiscovery = discoverAgents(tempDir, "both");
			expect(bothDiscovery.agents.find((agent) => agent.name === "scout")?.source).toBe("project");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
