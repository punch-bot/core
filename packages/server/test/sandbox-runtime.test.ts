import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@punch-bot/ai";
import { expect, test, vi } from "vitest";
import { createSandboxRuntime } from "../src/supervisor/runtime.ts";

test("runs outside coding-agent and retains completed operations across runtime replacement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-runtime-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("sandbox answer")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const options = { directory, models, model: faux.getModel(), onError: (error: unknown) => errors.push(error) };
	let runtime: Awaited<ReturnType<typeof createSandboxRuntime>> | undefined;
	try {
		runtime = await createSandboxRuntime(options);
		await expect(createSandboxRuntime(options)).rejects.toThrow("already has a runtime writer");
		const metadata = await runtime.create();
		const session = await runtime.attach(metadata.id);
		const request = { operationId: "test-operation", text: "question" };
		expect(await session.operations.accept(request, BACKGROUND_CONTEXT)).toMatchObject({
			operationId: request.operationId,
		});
		await expect
			.poll(async () => (await session.operations.status(request.operationId, BACKGROUND_CONTEXT)).status)
			.toBe("completed");
		const before = await session.lane.findEntries(undefined, BACKGROUND_CONTEXT);
		await runtime.close();
		runtime = undefined;
		runtime = await createSandboxRuntime(options);
		const reopened = await runtime.attach(metadata.id);
		expect(await reopened.operations.accept(request, BACKGROUND_CONTEXT)).toEqual({
			operationId: request.operationId,
			status: "completed",
		});
		expect(await reopened.lane.findEntries(undefined, BACKGROUND_CONTEXT)).toEqual(before);
		expect(errors).toEqual([]);
	} finally {
		await runtime?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("runtime tools use separate sandbox working directories and retain files after replacement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-runtime-files-"));
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "sandbox one" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("written"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const options = {
		directory: join(directory, "one"),
		models,
		model: faux.getModel(),
		onError: (error: unknown) => errors.push(error),
	};
	let first: Awaited<ReturnType<typeof createSandboxRuntime>> | undefined;
	let second: Awaited<ReturnType<typeof createSandboxRuntime>> | undefined;
	try {
		first = await createSandboxRuntime(options);
		second = await createSandboxRuntime({ ...options, directory: join(directory, "two") });
		const metadata = await first.create();
		const session = await first.attach(metadata.id);
		expect(await first.attach(metadata.id)).toBe(session);
		await session.operations.accept({ operationId: "write-file", text: "write a file" }, BACKGROUND_CONTEXT);
		await expect
			.poll(async () => (await session.operations.status("write-file", BACKGROUND_CONTEXT)).status)
			.toBe("completed");
		expect(await readFile(join(directory, "one/work/answer.txt"), "utf8")).toBe("sandbox one");
		await expect(readFile(join(directory, "two/work/answer.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(second.attach(metadata.id)).rejects.toThrow("Session not found");
		await first.close();
		first = undefined;
		first = await createSandboxRuntime(options);
		expect(await readFile(join(directory, "one/work/answer.txt"), "utf8")).toBe("sandbox one");
		await first.remove(metadata.id);
		expect(await first.list()).toEqual([]);
		expect(await readFile(join(directory, "one/work/answer.txt"), "utf8")).toBe("sandbox one");
		expect(errors).toEqual([]);
	} finally {
		await first?.close();
		await second?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reattaching resumes an admitted operation once without replaying its prompt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-runtime-recovery-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("recovered answer"), fauxAssistantMessage("next answer")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const options = { directory, models, model: faux.getModel(), onError: (error: unknown) => errors.push(error) };
	let runtime: Awaited<ReturnType<typeof createSandboxRuntime>> | undefined;
	try {
		runtime = await createSandboxRuntime(options);
		const metadata = await runtime.create();
		const session = await runtime.attach(metadata.id);
		expect(
			await session.lane.accept(
				{ kind: "prompt", operationId: "persisted", prompt: "original question" },
				BACKGROUND_CONTEXT,
			),
		).toMatchObject({ ok: true });
		await runtime.close();
		runtime = undefined;
		runtime = await createSandboxRuntime(options);
		const reopened = await runtime.attach(metadata.id);
		await Promise.all(
			Array.from({ length: 3 }, () =>
				reopened.operations.accept(
					{ operationId: "persisted", text: "must not replace original" },
					BACKGROUND_CONTEXT,
				),
			),
		);
		await expect
			.poll(async () => (await reopened.operations.status("persisted", BACKGROUND_CONTEXT)).status)
			.toBe("completed");
		expect(faux.state.callCount).toBe(1);
		const transcript = JSON.stringify(await reopened.lane.findEntries(undefined, BACKGROUND_CONTEXT));
		expect(transcript).toContain("original question");
		expect(transcript).not.toContain("must not replace original");
		await reopened.operations.accept({ operationId: "next", text: "next question" }, BACKGROUND_CONTEXT);
		await expect
			.poll(async () => (await reopened.operations.status("next", BACKGROUND_CONTEXT)).status)
			.toBe("completed");
		expect(faux.state.callCount).toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await runtime?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("evicts detached harnesses after their background operations finish", async () => {
	const directory = await mkdtemp(join(tmpdir(), "punch-runtime-idle-"));
	const faux = fauxProvider();
	let finish!: () => void;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	faux.setResponses([
		async () => {
			await completion;
			return fauxAssistantMessage("finished after detach");
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: unknown[] = [];
	const runtime = await createSandboxRuntime({
		directory,
		models,
		model: faux.getModel(),
		onError: (error) => errors.push(error),
	});
	try {
		const metadata = await runtime.create();
		const lease = await runtime.lease(metadata.id);
		const close = vi.spyOn(lease.session, "close");
		await lease.session.operations.accept({ operationId: "detached", text: "continue" }, BACKGROUND_CONTEXT);
		await expect.poll(() => faux.state.callCount).toBe(1);
		lease.release();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(close).not.toHaveBeenCalled();
		finish();
		await expect.poll(() => close.mock.calls.length, { timeout: 5_000 }).toBe(1);
		const reopened = await runtime.attach(metadata.id);
		expect(reopened).not.toBe(lease.session);
		expect(await reopened.operations.status("detached", BACKGROUND_CONTEXT)).toMatchObject({ status: "completed" });
		expect(errors).toEqual([]);
	} finally {
		finish();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
