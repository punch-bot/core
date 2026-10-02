import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default mergeConfig(baseConfig, defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@punch-bot\/durable$/, replacement: durableSrcIndex },
			{ find: /^@punch-bot\/durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
}));
