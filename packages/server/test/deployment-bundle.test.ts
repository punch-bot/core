import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { expect, test } from "vitest";
import { RuntimeSessions, SandboxOperations } from "../src/services.ts";
import { signRuntimeCapability } from "../src/supervisor/capability.ts";

test("deployment bundles exclude coding-agent and runtime boots outside the workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-bundle-"));
	try {
		await promisify(execFile)(process.execPath, [
			fileURLToPath(new URL("../../../scripts/bundle-sandbox-runtime.mjs", import.meta.url)),
			directory,
		]);
		const manifest = JSON.parse(await readFile(join(directory, "metafile.json"), "utf8")) as {
			inputs: Record<string, unknown>;
			outputs: Record<string, { entryPoint?: string }>;
		};
		expect(Object.keys(manifest.inputs).filter((path) => path.includes("packages/coding-agent/"))).toEqual([]);
		expect(Object.values(manifest.outputs).filter((output) => output.entryPoint)).toHaveLength(3);
		const token = "s".repeat(32);
		const sandboxId = randomUUID(),
			generation = randomUUID();
		const child = spawn(process.execPath, [join(directory, "runtime.mjs")], {
			cwd: directory,
			env: {
				PUNCH_PROVIDER: "faux",
				PUNCH_MODEL: "faux-1",
				PUNCH_SANDBOX_DIRECTORY: join(directory, "data"),
				PUNCH_SANDBOX_ID: sandboxId,
				PUNCH_WORKSPACE_ID: "workspace",
				PUNCH_RUNTIME_GENERATION: generation,
				PUNCH_RUNTIME_TOKEN: token,
				PUNCH_RUNTIME_PORT: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = once(child, "exit");
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		try {
			const url = await new Promise<string>((resolve, reject) => {
				const deadline = AbortSignal.timeout(10_000);
				deadline.addEventListener("abort", () => reject(new Error(`Runtime readiness timed out: ${stderr}`)), {
					once: true,
				});
				let stdout = "";
				child.once("error", reject);
				child.once("exit", () => reject(new Error(`Runtime exited before readiness: ${stderr}`)));
				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
					if (!stdout.includes("\n")) return;
					try {
						const value: unknown = JSON.parse(stdout.split("\n")[0]!);
						if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string")
							throw new Error("Invalid readiness log");
						resolve(value.url);
					} catch (error) {
						reject(error);
					}
				});
			});
			const response = await fetch(`${url}/ready`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(2000),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ sandboxId, generation, activeOperations: [] });
			const client = await Client.connect({
				serverId: sandboxId,
				transportFactory: createWebSocketTransportFactory({
					url: `${url.replace("http:", "ws:")}/punch`,
					async getAccessToken() {
						return signRuntimeCapability(token, generation, {
							userId: "user",
							workspaceId: "workspace",
							permissions: ["sessions:read", "sessions:create", "sessions:control"],
						});
					},
				}),
			});
			try {
				const session = await client.request(
					{ serverId: sandboxId },
					{ serviceId: RuntimeSessions.id, member: "create", args: [] },
				);
				if (!session || typeof session !== "object" || Array.isArray(session) || typeof session.id !== "string")
					throw new Error("Missing runtime session");
				await client.request(
					{ serverId: sandboxId },
					{ serviceId: RuntimeSessions.id, member: "attach", args: [session.id] },
				);
				for (const operationId of ["first", "second"]) {
					await client.request(client.attachment!, {
						serviceId: SandboxOperations.id,
						member: "accept",
						args: [{ operationId, text: "question" }],
					});
					await expect
						.poll(() =>
							client.request(client.attachment!, {
								serviceId: SandboxOperations.id,
								member: "status",
								args: [operationId],
							}),
						)
						.toEqual({ operationId, status: "completed" });
				}
			} finally {
				await client.dispose();
			}
			child.kill("SIGTERM");
			expect((await exited)[0], stderr).toBe(0);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

test("shutdown deadline fails the process when cleanup has no referenced handles", async () => {
	const source = new URL("../src/deployment/process.ts", import.meta.url).href;
	await expect(
		promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { installShutdown } from ${JSON.stringify(source)}; installShutdown(() => new Promise(() => {}), 50); process.emit("SIGTERM");`,
			],
			{ timeout: 5_000 },
		),
	).rejects.toMatchObject({ code: 1 });
});
