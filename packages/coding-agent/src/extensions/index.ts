import type { InlineExtension } from "../core/extensions/types.ts";
import contextPruningExtension from "./context-pruning/compress_context.ts";
import llamaExtension from "./llama/index.ts";
import reportProgressExtension from "./report-progress/index.ts";
import webfetchExtension from "./webfetch/index.ts";
import websearchExtension from "./websearch/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "websearch", factory: websearchExtension },
	{ name: "webfetch", factory: webfetchExtension },
	{ name: "report_progress", factory: reportProgressExtension },
	{ name: "context_pruning", factory: contextPruningExtension },
];
