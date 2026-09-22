import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Validate the rendered configuration so Compose interpolation cannot bypass image pinning. */
export function validateSandboxDeployment(config) {
	const images = {
		gateway: config.services?.gateway?.image,
		supervisor: config.services?.supervisor?.image,
		runtime: config.services?.supervisor?.environment?.PUNCH_RUNTIME_IMAGE,
	};
	for (const [name, image] of Object.entries(images)) {
		if (typeof image !== "string" || !/^(?:sha256:|.+@sha256:)[a-f0-9]{64}$/.test(image))
			throw new Error(`${name} image must be pinned by digest`);
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const config = execFileSync("docker", ["compose", ...process.argv.slice(2), "config", "--format", "json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	validateSandboxDeployment(JSON.parse(config));
	console.log("Gateway, supervisor and runtime image references are pinned by digest.");
}
