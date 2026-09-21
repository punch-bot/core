import { setTimeout as delay } from "node:timers/promises";
import type { SandboxRoute } from "./manager.ts";

/** Wait for application readiness, not merely a running container. */
export async function waitForSandboxRuntime(route: SandboxRoute, signal: AbortSignal): Promise<void> {
	const url = new URL("/ready", route.url);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Invalid runtime URL");
	while (true) {
		signal.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { authorization: `Bearer ${route.token}` },
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
			});
		} catch {
			await delay(100, undefined, { signal });
			continue;
		}
		if (response.status === 503) {
			await response.body?.cancel();
			await delay(100, undefined, { signal });
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Runtime readiness rejected with ${response.status}`);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing runtime readiness response");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > 4096) throw new Error("Runtime readiness response exceeds limit");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel();
		}
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			!("sandboxId" in value) ||
			value.sandboxId !== route.sandboxId ||
			!("generation" in value) ||
			value.generation !== route.generation
		)
			throw new Error("Runtime readiness identity mismatch");
		return;
	}
}
