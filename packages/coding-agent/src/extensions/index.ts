import type { InlineExtension } from "../core/extensions/types.ts";
import browserExtension from "./browser/index.ts";
import contextPruningExtension from "./context-pruning/compress_context.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import punchExtension from "./punch/index.ts";
import reportProgressExtension from "./report-progress/index.ts";
import subagentExtension from "./subagent/index.ts";
import webfetchExtension from "./webfetch/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "webfetch", factory: webfetchExtension },
	{ name: "report_progress", factory: reportProgressExtension },
	{ name: "subagent", factory: subagentExtension },
	{ name: "context_pruning", factory: contextPruningExtension },
	{ name: "browser", factory: browserExtension },
	{ name: "codemode", factory: codemodeExtension, builtin: true, replaceable: true },
	{ name: "tool-search", factory: toolSearchExtension, builtin: true, replaceable: true },
	{ name: "mcp", factory: mcpExtension, builtin: true, replaceable: true },
	{ name: "punch", factory: punchExtension },
];
