import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(process.argv[2] ?? join(tmpdir(), "punch-sandbox-image"));
execFileSync(process.execPath, [fileURLToPath(new URL("./bundle-sandbox-runtime.mjs", import.meta.url)), output], {
	stdio: "inherit",
});
const dockerfile = await readFile(resolve(output, "Dockerfile"), "utf8");
const nodeImage = process.env.PUNCH_NODE_IMAGE ?? dockerfile.match(/^ARG NODE_IMAGE=(.+)$/m)?.[1];
if (!nodeImage || !/^(?:sha256:|.+@sha256:)[a-f0-9]{64}$/.test(nodeImage))
	throw new Error("PUNCH_NODE_IMAGE must be pinned by digest");
const images = { node: nodeImage };
for (const entry of ["runtime", "supervisor", "gateway"]) {
	const iid = resolve(output, `${entry}.iid`);
	execFileSync(
		"docker",
		["build", "--build-arg", `NODE_IMAGE=${nodeImage}`, "--build-arg", `ENTRY=${entry}`, "--iidfile", iid, output],
		{ stdio: "inherit" },
	);
	images[entry] = (await readFile(iid, "utf8")).trim();
}
await writeFile(resolve(output, "images.json"), `${JSON.stringify(images, null, 2)}\n`);
await writeFile(
	resolve(output, "images.env"),
	["runtime", "supervisor", "gateway"].map(entry => `PUNCH_${entry.toUpperCase()}_IMAGE=${images[entry]}`).join("\n") + "\n",
);
console.log(`Image IDs written to ${resolve(output, "images.env")}`);
