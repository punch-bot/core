import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerEngine } from "../src/supervisor/docker.ts";

test("distinguishes missing containers from daemon failure and does not force deletion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-docker-"));
	const socketPath = join(directory, "docker.sock");
	const requests: string[] = [];
	let status = 404;
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		response.writeHead(status).end();
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const engine = new DockerEngine({ socketPath });
		expect(await engine.inspect("sandbox")).toBeUndefined();
		status = 500;
		await expect(engine.inspect("sandbox")).rejects.toThrow("returned 500");
		status = 204;
		await engine.remove("sandbox");
		expect(requests.at(-1)).toBe("DELETE /v1.45/containers/sandbox");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects a volume owned by another supervisor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-docker-"));
	const socketPath = join(directory, "docker.sock");
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.method!);
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ Labels: { owner: "other" } }));
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		await expect(new DockerEngine({ socketPath }).ensureVolume("data", { owner: "ours" })).rejects.toThrow(
			"ownership mismatch",
		);
		expect(requests).toEqual(["GET"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
