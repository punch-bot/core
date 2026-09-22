import assert from "node:assert/strict";
import test from "node:test";
import { validateSandboxDeployment } from "./validate-sandbox-deployment.mjs";

test("accepts local image IDs and registry digests", () => {
	validateSandboxDeployment({ services: {
		gateway: { image: `sha256:${"a".repeat(64)}` },
		supervisor: { image: `registry.test/supervisor@sha256:${"b".repeat(64)}`, environment: { PUNCH_RUNTIME_IMAGE: `registry.test/runtime:v1@sha256:${"c".repeat(64)}` } },
	} });
});

for (const name of ["gateway", "supervisor", "runtime"]) {
	test(`rejects mutable ${name} image references`, () => {
		const image = `sha256:${"a".repeat(64)}`;
		const config = { services: { gateway: { image }, supervisor: { image, environment: { PUNCH_RUNTIME_IMAGE: image } } } };
		if (name === "runtime") config.services.supervisor.environment.PUNCH_RUNTIME_IMAGE = "runtime:latest";
		else config.services[name].image = `${name}:latest`;
		assert.throws(() => validateSandboxDeployment(config), new RegExp(`${name} image must be pinned`));
	});
}
