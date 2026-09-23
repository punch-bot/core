import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createRemoteServiceBinding } from "@punch-bot/chord";
import { Client, createClientServiceTransport } from "@punch-bot/client";
import { createWebSocketTransportFactory } from "@punch-bot/client/websocket";
import { SignJWT } from "jose";
import { expect, test } from "vitest";
import { GatewaySessions, RuntimeTranscript, SandboxOperations } from "../src/services.ts";
import { createSupervisorClient } from "../src/supervisor/control.ts";

const execute = promisify(execFile);
const docker = async (...args: string[]): Promise<string> =>
	(await execute("docker", args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

// Explicit opt-in only. Normal offline tests never contact a Docker daemon.
test.skipIf(process.env.PUNCH_DOCKER_TEST !== "1")(
	"real images route sessions and preserve runtime work through gateway, supervisor and container replacement",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "punch-docker-integration-"));
		const name = `punch-test-${randomUUID()}`;
		const containers: string[] = [];
		const volumes = [`${name}-supervisor-data`, `${name}-gateway-data`, `${name}-config`];
		const clients: Client[] = [];
		const controlToken = randomUUID();
		const gatewayId = randomUUID();
		let networkCreated = false;
		let supervisorUrl: string | undefined;
		const run = async (suffix: string, image: string, args: string[]) => {
			const container = `${name}-${suffix}`;
			containers.push(container);
			await docker("run", "-d", "--name", container, "--network", name, ...args, image);
			return container;
		};
		const address = async (container: string, port: number) =>
			`http://${await docker("port", container, String(port)).then((value) => value.split("\n")[0])}`;
		try {
			await execute(
				process.execPath,
				[fileURLToPath(new URL("../../../scripts/build-sandbox-images.mjs", import.meta.url)), directory],
				{ timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
			);
			const images = JSON.parse(await readFile(join(directory, "images.json"), "utf8")) as {
				node: string;
				runtime: string;
				supervisor: string;
				gateway: string;
			};
			await docker("network", "create", name);
			networkCreated = true;
			for (const volume of volumes) await docker("volume", "create", volume);
			const environment = { PUNCH_PROVIDER: "faux", PUNCH_MODEL: "faux-1", PUNCH_FAUX_TOKENS_PER_SECOND: "0.5" };
			await writeFile(join(directory, "workspaces.json"), JSON.stringify({ one: environment, two: environment }));
			await writeFile(
				join(directory, "memberships.json"),
				JSON.stringify(
					["one", "two"].map((workspaceId) => ({
						oidcSubject: workspaceId,
						principal: {
							userId: workspaceId,
							workspaceId,
							permissions: ["sessions:read", "sessions:create", "sessions:control", "sessions:remove"],
						},
					})),
				),
			);
			const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
			await writeFile(
				join(directory, "jwks.json"),
				JSON.stringify({
					keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }],
				}),
			);
			// Public test-only TLS identity avoids a host OpenSSL dependency. JWT keys are generated per run.
			await copyFile(
				fileURLToPath(new URL("./fixtures/docker-oidc-cert.pem", import.meta.url)),
				join(directory, "cert.pem"),
			);
			await copyFile(
				fileURLToPath(new URL("./fixtures/docker-oidc-key.pem", import.meta.url)),
				join(directory, "key.pem"),
			);
			await copyFile(
				fileURLToPath(new URL("./fixtures/docker-oidc.mjs", import.meta.url)),
				join(directory, "oidc.mjs"),
			);
			// Override the base image command; this local issuer has no external dependencies.
			const oidc = `${name}-oidc`;
			containers.push(oidc);
			await docker(
				"create",
				"--name",
				oidc,
				"--network",
				name,
				"--network-alias",
				"oidc",
				"-v",
				`${volumes[2]}:/fixture`,
				images.node,
				"node",
				"/fixture/oidc.mjs",
			);
			for (const file of ["cert.pem", "key.pem", "oidc.mjs", "jwks.json", "workspaces.json", "memberships.json"])
				await docker("cp", join(directory, file), `${oidc}:/fixture/${file}`);
			await docker("start", oidc);
			const securityOptions = JSON.parse(await docker("info", "--format", "{{json .SecurityOptions}}")) as string[];
			const socketOptions = securityOptions.some((option) => option.startsWith("name=selinux"))
				? ["--security-opt", "label=disable"]
				: [];
			const supervisor = await run("supervisor", images.supervisor, [
				"--network-alias",
				"supervisor",
				...socketOptions,
				"-p",
				"127.0.0.1::8081",
				"-v",
				`${process.env.PUNCH_DOCKER_SOCKET_SOURCE ?? "/var/run/docker.sock"}:/var/run/docker.sock`,
				"-v",
				`${volumes[0]}:/state`,
				"-v",
				`${volumes[2]}:/config:ro`,
				"-e",
				"PUNCH_SUPERVISOR_DATABASE=/state/supervisor.db",
				"-e",
				`PUNCH_SUPERVISOR_TOKEN=${controlToken}`,
				"-e",
				`PUNCH_RUNTIME_IMAGE=${images.runtime}`,
				"-e",
				`PUNCH_DOCKER_NETWORK=${name}`,
				"-e",
				"PUNCH_WORKSPACE_ENVIRONMENTS=/config/workspaces.json",
			]);
			supervisorUrl = await address(supervisor, 8081);
			await expect
				.poll(
					async () => {
						try {
							return (await fetch(`${supervisorUrl}/v1/sandboxes`)).status;
						} catch {
							return 0;
						}
					},
					{ timeout: 10_000 },
				)
				.toBe(401);
			const control = createSupervisorClient(supervisorUrl, controlToken);
			const gateway = await run("gateway", images.gateway, [
				"-p",
				"127.0.0.1::8082",
				"-v",
				`${volumes[1]}:/state`,
				"-v",
				`${volumes[2]}:/config:ro`,
				"-e",
				`PUNCH_GATEWAY_ID=${gatewayId}`,
				"-e",
				"PUNCH_GATEWAY_DATABASE=/state/gateway.db",
				"-e",
				"PUNCH_SUPERVISOR_URL=http://supervisor:8081",
				"-e",
				`PUNCH_SUPERVISOR_TOKEN=${controlToken}`,
				"-e",
				"PUNCH_MEMBERSHIP_FILE=/config/memberships.json",
				"-e",
				"PUNCH_OIDC_ISSUER=https://oidc",
				"-e",
				"PUNCH_OIDC_AUDIENCE=punch",
				"-e",
				"PUNCH_OIDC_JWKS_URL=https://oidc/jwks",
				"-e",
				"PUNCH_OIDC_SCOPES=punch",
				"-e",
				"NODE_EXTRA_CA_CERTS=/config/cert.pem",
			]);
			let gatewayUrl = await address(gateway, 8082);
			await expect
				.poll(
					async () => {
						try {
							return (await fetch(gatewayUrl)).status;
						} catch {
							return 0;
						}
					},
					{ timeout: 10_000 },
				)
				.toBe(404);
			expect(
				await docker(
					"exec",
					gateway,
					"node",
					"-e",
					"fetch('https://oidc/jwks').then(r=>console.log(r.status)).catch(e=>{console.error(e);process.exitCode=1})",
				),
			).toBe("200");
			const connect = async (workspaceId: string) => {
				const token = await new SignJWT({ scope: "punch" })
					.setProtectedHeader({ alg: "RS256", kid: "test" })
					.setIssuer("https://oidc")
					.setAudience("punch")
					.setSubject(workspaceId)
					.setIssuedAt()
					.setExpirationTime("5m")
					.sign(keys.privateKey);
				const client = await Client.connect({
					serverId: gatewayId,
					transportFactory: createWebSocketTransportFactory({
						url: `${gatewayUrl.replace("http:", "ws:")}/punch`,
						async getAccessToken() {
							return token;
						},
					}),
				});
				clients.push(client);
				return client;
			};
			const one = await connect("one");
			const management = createRemoteServiceBinding({
				services: [GatewaySessions],
				transport: createClientServiceTransport(one, () => ({ serverId: gatewayId })),
				bound: true,
				assertAccess() {},
				onError(error) {
					throw error;
				},
			});
			await management.ready(BACKGROUND_CONTEXT);
			const sandbox = await control.create("one");
			containers.push(sandbox.container);
			volumes.push(sandbox.volume);
			const routes = await Promise.all(Array.from({ length: 4 }, () => control.acquire(sandbox.id, "one")));
			expect(new Set(routes.map((route) => route.generation)).size).toBe(1);
			expect((await docker("ps", "-q", "--filter", `label=punch.sandbox=${sandbox.id}`)).split("\n")).toHaveLength(
				1,
			);
			const session = await management.use(GatewaySessions).create(sandbox.id, BACKGROUND_CONTEXT);
			await management.use(GatewaySessions).attach(session.sessionId, BACKGROUND_CONTEXT);
			const binding = createRemoteServiceBinding({
				services: [SandboxOperations, RuntimeTranscript],
				transport: createClientServiceTransport(one, () => one.attachment),
				bound: true,
				assertAccess() {},
				onError(error) {
					throw error;
				},
			});
			await binding.ready(BACKGROUND_CONTEXT);
			const observer = await connect("one");
			await observer.request(
				{ serverId: gatewayId },
				{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
			);
			const two = await connect("two");
			await expect(
				two.request(
					{ serverId: gatewayId },
					{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
				),
			).rejects.toThrow();
			await expect(control.acquire(sandbox.id, "two")).rejects.toThrow();
			const other = await control.create("two");
			containers.push(other.container);
			volumes.push(other.volume);
			await control.acquire(other.id, "two");
			await docker("exec", sandbox.container, "sh", "-c", "printf retained > /sandbox/work/persisted.txt");
			await expect(docker("exec", other.container, "cat", "/sandbox/work/persisted.txt")).rejects.toThrow();
			await binding
				.use(SandboxOperations)
				.accept({ operationId: "survives", text: "keep working" }, BACKGROUND_CONTEXT);
			await expect.poll(() => binding.use(RuntimeTranscript).state.value?.snapshot.operation?.id).toBe("survives");
			expect(
				await observer.request(observer.attachment!, {
					serviceId: SandboxOperations.id,
					member: "status",
					args: ["survives"],
				}),
			).toEqual({ operationId: "survives", status: "open" });
			const runtimeId = await docker("inspect", "--format", "{{.Id}}", sandbox.container);
			await docker("restart", "-t", "3", gateway);
			gatewayUrl = await address(gateway, 8082);
			await docker("restart", "-t", "3", supervisor);
			supervisorUrl = await address(supervisor, 8081);
			const recoveredControl = createSupervisorClient(supervisorUrl, controlToken);
			await expect
				.poll(
					async () => {
						try {
							return await recoveredControl.acquire(sandbox.id, "one");
						} catch {
							return null;
						}
					},
					{ timeout: 15_000 },
				)
				.toEqual(routes[0]);
			expect(await docker("inspect", "--format", "{{.Id}}", sandbox.container)).toBe(runtimeId);
			const reconnected = await connect("one");
			await reconnected.request(
				{ serverId: gatewayId },
				{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
			);
			await expect
				.poll(
					() =>
						reconnected.request(reconnected.attachment!, {
							serviceId: SandboxOperations.id,
							member: "status",
							args: ["survives"],
						}),
					{ timeout: 30_000 },
				)
				.toEqual({ operationId: "survives", status: "completed" });
			await recoveredControl.stop(sandbox.id, "one");
			expect(await docker("inspect", "--format", "{{.State.Running}}", sandbox.container)).toBe("false");
			const replacement = await recoveredControl.acquire(sandbox.id, "one");
			expect(replacement.generation).not.toBe(routes[0]!.generation);
			expect(replacement.token).not.toBe(routes[0]!.token);
			expect(await docker("exec", sandbox.container, "cat", "/sandbox/work/persisted.txt")).toBe("retained");
			const finalClient = await connect("one");
			await finalClient.request(
				{ serverId: gatewayId },
				{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
			);
			expect(
				await finalClient.request(finalClient.attachment!, {
					serviceId: SandboxOperations.id,
					member: "accept",
					args: [{ operationId: "survives", text: "keep working" }],
				}),
			).toEqual({ operationId: "survives", status: "completed" });
			const restored = createRemoteServiceBinding({
				services: [RuntimeTranscript, SandboxOperations],
				transport: createClientServiceTransport(finalClient, () => finalClient.attachment),
				bound: true,
				assertAccess() {},
				onError(error) {
					throw error;
				},
			});
			await restored.ready(BACKGROUND_CONTEXT);
			await expect
				.poll(() => restored.use(RuntimeTranscript).state.value?.snapshot.transcript)
				.toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "message",
							message: expect.objectContaining({
								role: "user",
								content: [{ type: "text", text: "keep working" }],
							}),
						}),
						expect.objectContaining({
							type: "message",
							message: expect.objectContaining({
								role: "assistant",
								content: expect.arrayContaining([
									expect.objectContaining({ type: "text", text: "sandbox smoke answer" }),
								]),
							}),
						}),
					]),
				);
			const controller = await connect("one");
			await controller.request(
				{ serverId: gatewayId },
				{ serviceId: GatewaySessions.id, member: "attach", args: [session.sessionId] },
			);
			await restored
				.use(SandboxOperations)
				.accept({ operationId: "abortable", text: "stop this turn" }, BACKGROUND_CONTEXT);
			await expect
				.poll(() => restored.use(RuntimeTranscript).state.value?.snapshot.operation?.streamingMessage)
				.toBeDefined();
			await controller.request(controller.attachment!, {
				serviceId: SandboxOperations.id,
				member: "abort",
				args: ["abortable"],
			});
			await expect
				// The deliberately slow faux provider observes cancellation after its current chunk delay.
				.poll(() => restored.use(SandboxOperations).status("abortable", BACKGROUND_CONTEXT), { timeout: 15_000 })
				.toEqual({
					operationId: "abortable",
					status: "aborted",
				});
			await recoveredControl.delete(sandbox.id, "one", false);
			expect(await docker("volume", "inspect", "--format", "{{.Name}}", sandbox.volume)).toBe(sandbox.volume);
			await recoveredControl.delete(sandbox.id, "one", true);
			await expect(docker("volume", "inspect", sandbox.volume)).rejects.toThrow();
			await recoveredControl.delete(other.id, "two", true);
		} catch (error) {
			for (const container of containers) {
				const logs = await execute("docker", ["logs", "--tail", "40", container])
					.then(({ stdout, stderr }) => stdout + stderr)
					.catch(() => "Container unavailable");
				console.error(`${container}:\n${logs}`);
			}
			throw error;
		} finally {
			await Promise.allSettled(clients.map((client) => client.dispose()));
			await Promise.allSettled(containers.map((container) => docker("rm", "-f", container)));
			await Promise.allSettled(volumes.map((volume) => docker("volume", "rm", volume)));
			if (networkCreated) await docker("network", "rm", name);
			await rm(directory, { recursive: true, force: true });
		}
	},
	480_000,
);
