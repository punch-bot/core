import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { expect, test } from "vitest";
import { withPrincipal } from "../src/principal.ts";
import { GatewaySessions, SandboxOperations } from "../src/services.ts";
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
	const supervisor: SupervisorClient = {
		async create() {
			return summary;
		},
		async inspect() {
			return summary;
		},
		async acquire() {
			return { sandboxId, generation, token, url: runtime.url };
		},
		async stop() {
			throw new Error("Gateway must not stop the sandbox");
		},
		async delete() {
			throw new Error("Gateway must not delete the sandbox");
		},
	};
	const options = { databasePath: join(directory, "gateway.db"), supervisor };
	let gateway = createSandboxGatewayHost(options);
	const context = withPrincipal(
		{
			workspaceId: "workspace",
			userId: "user",
			permissions: ["sessions:read", "sessions:create", "sessions:control"],
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
		expect(errors).toEqual([]);
	} finally {
		await gateway.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
