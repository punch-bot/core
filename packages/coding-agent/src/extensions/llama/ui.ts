import type { ExtensionCommandContext, ExtensionUIDialogOptions } from "../../core/extensions/types.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
import type { HuggingFaceModel } from "./huggingface.ts";

export type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

interface ProgressState extends LlamaProgress {
	title: string;
	model: string;
}

function contextLabel(model: LlamaModelInfo): string | undefined {
	const context = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	if (context) return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context);
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] !== "--ctx-size" && args[index] !== "-c" && args[index] !== "-ctx") continue;
		const value = Number(args[index + 1]);
		if (Number.isFinite(value) && value > 0) return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
	}
	return undefined;
}

function modelLabel(model: LlamaModelInfo): string {
	const details: string[] = [model.id];
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	if (loaded) details.push("loaded");
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	const context = loaded ? contextLabel(model) : undefined;
	if (context) details.push(`${context} context`);
	return details.join(" · ");
}

export interface LlamaUi {
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	showStatus(title: string, message: string): void;
	progress(state: ProgressState): Promise<void>;
	updateProgress(state: ProgressState): void;
	clearProgress(): void;
}

class DialogLlamaUi implements LlamaUi {
	private readonly ctx: ExtensionCommandContext;
	private readonly progressKey = "llama-progress";

	constructor(ctx: ExtensionCommandContext) {
		this.ctx = ctx;
	}

	async showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		const options = [...models.map(modelLabel), "Download model", "Close"];
		const choice = await this.ctx.ui.select(`llama.cpp  ${serverUrl}`, options);
		if (!choice || choice === "Close") return { type: "close" };
		if (choice === "Download model") return { type: "download" };
		const model = models.find((entry) => modelLabel(entry) === choice);
		return model ? { type: "model", model } : { type: "close" };
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		return this.ctx.ui.select(title, options);
	}

	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		return this.ctx.ui.confirm(title, message, opts);
	}

	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		const choice = await this.ctx.ui.select(`Could not reach ${serverUrl}\n${message}`, ["Retry", "Close"]);
		return choice === "Retry" ? "retry" : "close";
	}

	async searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		const query = await this.ctx.ui.input("Search Hugging Face models", "owner/name");
		if (!query || query.trim().length < 2) return undefined;
		const trimmed = query.trim();
		if (/^[^/\s]+\/[^:\s]+(?::[^:\s]+)?$/u.test(trimmed)) return trimmed;
		let results: HuggingFaceModel[];
		try {
			results = await search(trimmed, new AbortController().signal);
		} catch (error: unknown) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return undefined;
		}
		if (results.length === 0) {
			this.ctx.ui.notify("No models found", "warning");
			return undefined;
		}
		return this.ctx.ui.select(
			"Select a model",
			results.map((model) => model.id),
		);
	}

	showStatus(title: string, message: string): void {
		this.ctx.ui.notify(`${title}: ${message}`);
	}

	async progress(state: ProgressState): Promise<void> {
		this.updateProgress(state);
	}

	updateProgress(state: ProgressState): void {
		const percent = state.ratio !== undefined ? ` ${Math.round(state.ratio * 100)}%` : "";
		const detail = state.detail ? ` (${state.detail})` : "";
		this.ctx.ui.setStatus(this.progressKey, `${state.title}${percent}: ${state.message ?? state.model}${detail}`);
	}

	clearProgress(): void {
		this.ctx.ui.setStatus(this.progressKey, undefined);
	}
}

export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	const ui = new DialogLlamaUi(ctx);
	try {
		await run(ui);
	} catch (error: unknown) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ui.clearProgress();
	}
}

export async function runWithProgress<T>(
	ui: LlamaUi,
	options: {
		title: string;
		model: string;
		initialMessage: string;
		cancelTitle: string;
		cancelMessage: string;
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		cancel(): Promise<void>;
	},
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	const controller = new AbortController();
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	ui.updateProgress(state);
	try {
		const settled = options
			.run(controller.signal, (progress) => {
				state.message = progress.message;
				state.ratio = progress.ratio;
				state.detail = progress.detail;
				ui.updateProgress(state);
			})
			.then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
		let completed = false;
		void settled.finally(() => {
			completed = true;
		});

		while (!completed) {
			const dialogAbort = new AbortController();
			const started = Date.now();
			const outcome = await Promise.race([
				settled.then(() => "settled" as const),
				ui
					.confirm(options.cancelTitle, options.cancelMessage, { signal: dialogAbort.signal })
					.then((stop) => (stop ? ("stop" as const) : ("keep" as const))),
			]);
			dialogAbort.abort();
			if (outcome === "settled") break;
			if (outcome === "stop" && !completed) {
				try {
					await options.cancel();
				} finally {
					controller.abort(new Error("Cancelled"));
				}
				await settled;
				return { cancelled: true };
			}
			// Instant false means a no-op UI (print mode). Wait for the job instead of spinning.
			if (Date.now() - started < 50) {
				await settled;
				break;
			}
		}

		const result = await settled;
		if (!result.ok) {
			if (controller.signal.aborted) return { cancelled: true };
			throw result.error;
		}
		return { cancelled: false, value: result.value };
	} finally {
		ui.clearProgress();
	}
}
