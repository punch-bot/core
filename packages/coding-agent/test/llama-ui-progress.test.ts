import { describe, expect, it } from "vitest";
import type { ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import type { LlamaProgress } from "../src/extensions/llama/client.ts";
import { type LlamaUi, runWithProgress } from "../src/extensions/llama/ui.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createUi(
	confirm: LlamaUi["confirm"],
	onProgress?: (state: { detail?: string; message: string }) => void,
): LlamaUi {
	return {
		showModels: async () => ({ type: "close" }),
		select: async () => undefined,
		confirm,
		connectionError: async () => "close",
		searchModels: async () => undefined,
		showStatus: () => {},
		progress: async () => {},
		updateProgress: (state) => {
			onProgress?.(state);
		},
	};
}

describe("runWithProgress", () => {
	it("aborts the stop dialog when the job finishes first", async () => {
		const job = deferred<string>();
		const confirmStarted = deferred<void>();
		let seenSignal: AbortSignal | undefined;
		let cancelled = false;
		const ui = createUi(async (_title, _message, opts) => {
			seenSignal = opts?.signal;
			confirmStarted.resolve();
			await new Promise<void>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return false;
		});

		const resultPromise = runWithProgress(ui, {
			title: "Load",
			model: "m",
			initialMessage: "loading",
			cancelTitle: "Stop?",
			cancelMessage: "stop",
			run: async () => job.promise,
			cancel: async () => {
				cancelled = true;
			},
		});

		await confirmStarted.promise;
		job.resolve("ok");
		await expect(resultPromise).resolves.toEqual({ cancelled: false, value: "ok" });
		expect(seenSignal?.aborted).toBe(true);
		expect(cancelled).toBe(false);
	});

	it("cancels the job when the user confirms stop", async () => {
		let cancelled = false;
		const ui = createUi(async () => true);

		const result = await runWithProgress(ui, {
			title: "Load",
			model: "m",
			initialMessage: "loading",
			cancelTitle: "Stop?",
			cancelMessage: "stop",
			run: async (signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							reject(signal.reason);
						},
						{ once: true },
					);
				});
				return "never";
			},
			cancel: async () => {
				cancelled = true;
			},
		});

		expect(result).toEqual({ cancelled: true });
		expect(cancelled).toBe(true);
	});

	it("offers cancel again after the user declines", async () => {
		const job = deferred<string>();
		let confirms = 0;
		const secondStarted = deferred<void>();
		const ui = createUi(async (_title, _message, opts?: ExtensionUIDialogOptions) => {
			confirms++;
			if (confirms === 1) {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return false;
			}
			secondStarted.resolve();
			await new Promise<void>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return false;
		});

		const resultPromise = runWithProgress(ui, {
			title: "Load",
			model: "m",
			initialMessage: "loading",
			cancelTitle: "Stop?",
			cancelMessage: "stop",
			run: async () => job.promise,
			cancel: async () => {
				throw new Error("should not cancel");
			},
		});

		await secondStarted.promise;
		expect(confirms).toBe(2);
		job.resolve("ok");
		await expect(resultPromise).resolves.toEqual({ cancelled: false, value: "ok" });
	});

	it("clears omitted progress fields instead of leaving stale detail", async () => {
		const details: Array<string | undefined> = [];
		const ui = createUi(
			async () => false,
			(state) => {
				details.push(state.detail);
			},
		);

		await runWithProgress(ui, {
			title: "Download",
			model: "m",
			initialMessage: "starting",
			cancelTitle: "Stop?",
			cancelMessage: "stop",
			run: async (_signal, update: (progress: LlamaProgress) => void) => {
				update({ message: "downloading", ratio: 0.5, detail: "10MB" });
				update({ message: "finalizing" });
				return "ok";
			},
			cancel: async () => {},
		});

		expect(details).toContain("10MB");
		expect(details.at(-1)).toBeUndefined();
	});
});
