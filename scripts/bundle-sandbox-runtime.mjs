import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(process.argv[2] ?? join(tmpdir(), "punch-sandbox-image"));
await mkdir(output, { recursive: true });
const result = await build({
	absWorkingDir: root,
	entryPoints: {
		runtime: "packages/server/src/supervisor/runtime-entry.ts",
		supervisor: "packages/server/src/supervisor/entry.ts",
		gateway: "packages/server/src/gateway/entry.ts",
	},
	outdir: output,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	metafile: true,
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const forbidden = Object.keys(result.metafile.inputs).filter(path => path.includes("packages/coding-agent/"));
if (forbidden.length) throw new Error(`Server deployment imports coding-agent: ${forbidden.join(", ")}`);
await writeFile(resolve(output, "metafile.json"), JSON.stringify(result.metafile, null, 2));
await writeFile(resolve(output, "Dockerfile"), [
	"ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
	"FROM ${NODE_IMAGE}",
	"ARG ENTRY=runtime",
	"WORKDIR /app",
	"COPY ${ENTRY}.mjs /app/entry.mjs",
	'ENTRYPOINT ["node", "/app/entry.mjs"]',
	"",
].join("\n"));
console.log(`Gateway, supervisor and runtime build context: ${output}`);
