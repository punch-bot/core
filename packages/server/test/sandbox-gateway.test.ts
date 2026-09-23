import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { createServiceSubscribeCall } from "@punch-bot/chord";
import { expect, test } from "vitest";
import { withPrincipal } from "../src/principal.ts";
import { GatewaySessions, RuntimeTranscript, SandboxOperations } from "../src/services.ts";
import type { SupervisorClient } from "../src/supervisor/control.ts";
import { createSandboxGatewayHost } from "../src/supervisor/gateway-host.ts";
import { startSandboxRuntimeServer } from "../src/supervisor/runtime-server.ts";

test("gateway catalogs persist remote sessions and enforce workspace access", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-gateway-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("routed answer")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const sandboxId = randomUUID(),
		generation = randomUUID(),
		token = "s".repeat(32);
	const runtime = await startSandboxRuntimeServer({
		directory: join(directory, "runtime"),
		models,
		model: faux.getModel(),
		sandboxId,
		generation,
		token,
		workspaceId: "workspace",
		hostname: "127.0.0.1",
		port: 0,
		onError(error) {
			errors.push(error);
		},
	});
	const summary = {
		id: sandboxId,
		workspaceId: "workspace",
		generation,
		container: "container",
		volume: "volume",
		desired: "running" as const,
		state: "ready" as const,
		deleteData: false,
	};
	let deleted = false;
	let deleteOnAcquire = false;
	let failAcquire = false;
	let inspectCalls = 0;
	let failOnInspectCall = 0;
	let authorized = true;
	let revokedChecks = 0;
	let removed: string | undefined;
	const supervisor: SupervisorClient = {
		async create() {
			return summary;
		},
		async inspect() {
			if (++inspectCalls === failOnInspectCall) throw new Error("Supervisor unreachable");
			return deleted ? { ...summary, desired: "deleted", state: "deleted" } : summary;
		},
		async acquire() {
			if (deleteOnAcquire) deleted = true;
			if (deleted) throw new Error("Sandbox deleted");
			if (failAcquire) throw new Error("Runtime unavailable");
			return { sandboxId, generation, token, url: runtime.url };
		},
		async stop() {
			throw new Error("Gateway must not stop the sandbox");
		},
		async delete() {
			throw new Error("Gateway must not delete the sandbox");
		},
	};
	const options = {
		databasePath: join(directory, "gateway.db"),
		supervisor,
		async authorizePrincipal() {
			if (!authorized) {
				revokedChecks++;
				throw new Error("Membership revoked");
			}
		},
		async onSessionRemoved(id: string) {
			removed = id;
		},
	};
	let gateway = createSandboxGatewayHost(options);
	const context = withPrincipal(
		{
			workspaceId: "workspace",
			userId: "user",
			permissions: ["sessions:read", "sessions:create", "sessions:control", "sessions:remove"],
		},
		BACKGROUND_CONTEXT,
	);
	const other = withPrincipal(
		{ workspaceId: "other", userId: "other", permissions: ["sessions:read", "sessions:control"] },
		BACKGROUND_CONTEXT,
	);
	const presentation = { async attachSession() {}, async detachSession() {}, async prepareSessionRemoval() {} };
	try {
		const services = await gateway.host.serverServices.attachClient(presentation, context);
		const created = await services.invokeService(
			{ serviceId: GatewaySessions.id, member: "create", args: [null] },
			async () => {},
			context,
		);
		if (!created || typeof created !== "object" || Array.isArray(created) || typeof created.sessionId !== "string")
			throw new Error("Missing session summary");
		const id = created.sessionId;
		await expect(gateway.host.resolveSession(id, other)).rejects.toThrow("access denied");
		const metadata = await gateway.host.resolveSession(id, context);
		const handle = await gateway.host.openSession(metadata, context);
		try {
			const attachment = await handle.attachClient(context);
			await attachment.invokeService(
				{
					serviceId: SandboxOperations.id,
					member: "accept",
					args: [{ operationId: "gateway-operation", text: "question" }],
				},
				async () => {},
				context,
			);
			await expect
				.poll(
					() =>
						attachment.invokeService(
							{ serviceId: SandboxOperations.id, member: "status", args: ["gateway-operation"] },
							async () => {},
							context,
						),
					{ timeout: 5_000 },
				)
				.toEqual({ operationId: "gateway-operation", status: "completed" });
			const updates: unknown[] = [];
			await attachment.invokeService(
				createServiceSubscribeCall("revoked-transcript", RuntimeTranscript.id, "singleton"),
				async (_id, update) => {
					updates.push(update);
				},
				context,
			);
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			faux.setResponses([
				async () => {
					await completion;
					return fauxAssistantMessage("answer after revocation");
				},
			]);
			try {
				await attachment.invokeService(
					{
						serviceId: SandboxOperations.id,
						member: "accept",
						args: [{ operationId: "revoked-operation", text: "question" }],
					},
					async () => {},
					context,
				);
				await expect.poll(() => faux.state.callCount, { timeout: 5_000 }).toBe(2);
				const before = updates.length;
				authorized = false;
				finish();
				await expect.poll(() => revokedChecks, { timeout: 5_000 }).toBeGreaterThan(0);
				await expect(
					attachment.invokeService(
						{ serviceId: SandboxOperations.id, member: "status", args: ["revoked-operation"] },
						async () => {},
						context,
					),
				).rejects.toThrow("closed");
				expect(updates).toHaveLength(before);
			} finally {
				finish();
				authorized = true;
			}
		} finally {
			await handle.close(context);
		}
		await services.release(context);
		await gateway.close();
		gateway = createSandboxGatewayHost(options);
		expect(await gateway.host.resolveSession(id, context)).toEqual(metadata);
		const hidden = await gateway.host.serverServices.attachClient(presentation, other);
		expect(
			await hidden.invokeService({ serviceId: GatewaySessions.id, member: "list", args: [] }, async () => {}, other),
		).toEqual([]);
		await hidden.release(other);
		deleted = true;
		const cleanup = await gateway.host.serverServices.attachClient(presentation, context);
		await cleanup.invokeService(
			{ serviceId: GatewaySessions.id, member: "remove", args: [id] },
			async () => {},
			context,
		);
		expect(removed).toBe(id);
		expect(
			await cleanup.invokeService(
				{ serviceId: GatewaySessions.id, member: "list", args: [] },
				async () => {},
				context,
			),
		).toEqual([]);
		deleted = false;
		const next = await cleanup.invokeService(
			{ serviceId: GatewaySessions.id, member: "create", args: [null] },
			async () => {},
			context,
		);
		if (!next || typeof next !== "object" || Array.isArray(next) || typeof next.sessionId !== "string")
			throw new Error("Missing second session summary");
		failAcquire = true;
		await expect(
			cleanup.invokeService(
				{ serviceId: GatewaySessions.id, member: "remove", args: [next.sessionId] },
				async () => {},
				context,
			),
		).rejects.toThrow("Runtime unavailable");
		expect(await gateway.host.resolveSession(next.sessionId, context)).toMatchObject({ id: next.sessionId });
		expect(removed).toBe(id);
		failOnInspectCall = inspectCalls + 2;
		await expect(
			cleanup.invokeService(
				{ serviceId: GatewaySessions.id, member: "remove", args: [next.sessionId] },
				async () => {},
				context,
			),
		).rejects.toThrow("Runtime unavailable");
		expect(await gateway.host.resolveSession(next.sessionId, context)).toMatchObject({ id: next.sessionId });
		expect(removed).toBe(id);
		failAcquire = false;
		deleteOnAcquire = true;
		await cleanup.invokeService(
			{ serviceId: GatewaySessions.id, member: "remove", args: [next.sessionId] },
			async () => {},
			context,
		);
		expect(removed).toBe(next.sessionId);
		expect(
			await cleanup.invokeService(
				{ serviceId: GatewaySessions.id, member: "list", args: [] },
				async () => {},
				context,
			),
		).toEqual([]);
		await cleanup.release(context);
		expect(errors).toEqual([]);
	} finally {
		await gateway.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
