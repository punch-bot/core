#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { execNpmSync } from "./npm-command.mjs";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) throw new Error("Usage: node scripts/publish.mjs [--dry-run]");

/** Whether npm knows `spec`, a package name or `name@version`; a 404 means it does not. */
function existsOnRegistry(spec) {
	try {
		const output = execNpmSync(["view", spec, "version", "--json"], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "pipe"],
		});
		if (!output.trim()) throw new Error(`npm returned no version for ${spec}`);
		return true;
	} catch (error) {
		const output = error && typeof error === "object"
			? ["stdout", "stderr"].map((key) => key in error ? String(error[key] ?? "") : "").filter(Boolean).join("\n")
			: "";
		if (output.includes("E404") || output.includes("404 Not Found")) return false;
		throw new Error(`Failed to query ${spec}${output ? `\n${output}` : ""}`, { cause: error });
	}
}

const repoRoot = process.cwd();
const packages = getPublicWorkspacePackages();
const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const versions = [...new Set(packages.map((pkg) => pkg.version))];
if (versions.length !== 1) throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
for (const pkg of packages) {
	if (!existsSync(join(pkg.directory, "dist"))) {
		throw new Error(`${pkg.directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

console.log(`Publishing pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);
const artifactSet = produceArtifactSet({ build: false, repoRoot });
try {
	const packageStates = artifactSet.packages.map((pkg) => ({
		...pkg,
		published: existsOnRegistry(`${pkg.name}@${pkg.version}`),
	}));
	for (const pkg of packageStates) {
		console.log(`${pkg.name}@${pkg.version} ${pkg.published ? "is already published" : "is ready to publish"}: ${pkg.tarballPath}`);
	}
	// npm trusted publishing cannot create a package: its publisher is configured in the settings of an existing one.
	// Check before publishing anything, so other packages never go out depending on a package that then fails.
	const newPackages = packageStates.filter((pkg) => !pkg.published && !existsOnRegistry(pkg.name)).map((pkg) => pkg.name);
	if (newPackages.length > 0) {
		const message = `${newPackages.join(", ")} ${newPackages.length === 1 ? "has" : "have"} never been published. Trusted publishing cannot publish a package for the first time, so this publish needs the NPM_TOKEN secret, or a first publish by hand.`;
		if (!dryRun && !process.env.NODE_AUTH_TOKEN) throw new Error(message);
		console.log(`\nNote: ${message}`);
	}
	console.log(dryRun ? "\nDry-running tarball publication with provenance.\n" : "\nAll packages packed; starting publication.\n");
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}
		const args = ["publish", pkg.tarballPath, "--access", "public", "--provenance", "--ignore-scripts"];
		if (dryRun) args.push("--dry-run");
		execNpmSync(args, {
			cwd: packageByName.get(pkg.name).directory,
			stdio: "inherit",
		});
		console.log();
	}
} finally {
	rmSync(artifactSet.artifactDirectory, { force: true, recursive: true });
}
