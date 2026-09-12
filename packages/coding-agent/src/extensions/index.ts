import type { InlineExtension } from "../core/extensions/types.ts";
import browserExtension from "./browser/index.ts";
import contextPruningExtension from "./context-pruning/compress_context.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import punchExtension from "./punch/index.ts";
import reportProgressExtension from "./report-progress/index.ts";
import subagentExtension from "./subagent/index.ts";
import webfetchExtension from "./webfetch/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "webfetch", factory: webfetchExtension },
	{ name: "report_progress", factory: reportProgressExtension },
	{ name: "subagent", factory: subagentExtension },
	{ name: "context_pruning", factory: contextPruningExtension },
	{ name: "browser", factory: browserExtension },
	{ name: "mcp", factory: mcpExtension },
	{ name: "punch", factory: punchExtension },
];
