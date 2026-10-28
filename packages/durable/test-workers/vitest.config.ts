import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Runs in workerd: the Durable Object storage, alarms, and eviction are Cloudflare's own.
export default defineConfig({
	root: source("."),
	plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
	test: { include: ["*.test.ts"] },
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@punch-bot\/durable$/, replacement: source("../src/index.ts") },
			{ find: /^@punch-bot\/durable\/testing$/, replacement: source("../src/testing/index.ts") },
			{
				find: /^@punch-bot\/durable\/storage\/sqlite\/cloudflare$/,
				replacement: source("../src/storage/sqlite/cloudflare.ts"),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
