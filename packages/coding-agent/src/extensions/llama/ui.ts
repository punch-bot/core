import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
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
	confirm(title: string, message: string): Promise<boolean>;
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	showStatus(title: string, message: string): void;
	progress(state: ProgressState): Promise<void>;
	updateProgress(state: ProgressState): void;
}

class DialogLlamaUi implements LlamaUi {
	private readonly ctx: ExtensionCommandContext;

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

	confirm(title: string, message: string): Promise<boolean> {
		return this.ctx.ui.confirm(title, message);
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
		const results = await search(query.trim(), new AbortController().signal);
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
		this.ctx.ui.notify(`${state.title}${percent}: ${state.message ?? state.model}`);
	}
}

export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	try {
		await run(new DialogLlamaUi(ctx));
	} catch (error: unknown) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
		const value = await options.run(controller.signal, (progress) => {
			Object.assign(state, progress);
			ui.updateProgress(state);
		});
		return { cancelled: false, value };
	} catch (error) {
		if (controller.signal.aborted) return { cancelled: true };
		throw error;
	}
}
