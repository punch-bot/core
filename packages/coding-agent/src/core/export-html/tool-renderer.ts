/**
 * Tool HTML renderer for HTML export.
 *
 * Custom TUI tool renderers were removed with interactive mode. Export falls back
 * to structured tool arguments and results.
 */

import type { ToolDefinition } from "../extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

export interface ToolHtmlRendererDeps {
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	theme: Theme;
	cwd: string;
	width?: number;
}

export interface ToolHtmlRenderer {
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

export function createToolHtmlRenderer(_deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	return {
		renderCall() {
			return undefined;
		},
		renderResult() {
			return undefined;
		},
	};
}
