import { type AgentLane, BACKGROUND_CONTEXT } from "@punch-bot/agent";
import type { SandboxOperationStatus, SandboxOperations } from "../services.ts";

/** Admission is durable before acknowledgement. Drives belong to the runtime, never an RPC request. */
export function createSandboxOperations(
	lane: Pick<AgentLane, "accept" | "drive" | "getResult" | "inspectExecution" | "requestAbort">,
	onError: (error: unknown) => void,
): { service: SandboxOperations; close(): Promise<void> } {
	let admissions = Promise.resolve();
	let closed = false;
	let closing: Promise<void> | undefined;
	const drives = new Map<string, Promise<unknown>>();
	const report = (error: unknown): void => {
		try {
			onError(error);
		} catch {
			/* Observers cannot interrupt cleanup. */
		}
	};
	const status = async (operationId: string): Promise<SandboxOperationStatus> => {
		const result = await lane.getResult(operationId, BACKGROUND_CONTEXT);
		if (result) return { operationId, status: result.status };
		const current = (await lane.inspectExecution(BACKGROUND_CONTEXT)).current;
		return { operationId, status: current?.id === operationId ? current.status : "unknown" };
	};
	return {
		service: {
			accept(request, context) {
				const admitted = admissions.then(async () => {
					if (closed) throw new Error("Sandbox runtime is stopping");
					context.abortSignal?.throwIfAborted();
					if (
						!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId) ||
						!request.text.trim() ||
						request.text.length > 32_000
					)
						throw new Error("Invalid sandbox prompt");
					const previous = await status(request.operationId);
					if (previous.status !== "unknown") return previous;
					const result = await lane.accept(
						{ kind: "prompt", operationId: request.operationId, prompt: request.text },
						BACKGROUND_CONTEXT,
					);
					if (!result.ok) throw new Error(result.error.message);
					const drive = lane.drive(
						{ operationId: result.value.operationId, waitForRetry: true, pollDeferred: true },
						BACKGROUND_CONTEXT,
					);
					drives.set(result.value.operationId, drive);
					void drive
						.then((result) => {
							if (!result.ok) report(result.error);
						}, report)
						.finally(() => drives.delete(request.operationId));
					return { operationId: result.value.operationId, status: "running" as const };
				});
				admissions = admitted.then(
					() => {},
					() => {},
				);
				return admitted;
			},
			status,
			async abort(operationId) {
				const result = await lane.requestAbort(operationId, BACKGROUND_CONTEXT);
				if (!result.ok) throw new Error(result.error.message);
			},
		},
		close() {
			closed = true;
			closing ??= (async () => {
				await admissions;
				await Promise.allSettled([...drives.keys()].map((id) => lane.requestAbort(id, BACKGROUND_CONTEXT)));
				await Promise.allSettled(drives.values());
			})();
			return closing;
		},
	};
}
