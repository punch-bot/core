import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["test/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
}));
