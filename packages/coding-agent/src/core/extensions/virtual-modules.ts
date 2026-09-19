import * as bundledPiAgentCore from "@punch-bot/agent";
import * as bundledPiAiCompat from "@punch-bot/ai/compat";
import * as bundledPiAiOauth from "@punch-bot/ai/oauth";
import * as bundledPiAiProviders from "@punch-bot/ai/providers/all";
import * as bundledPiTui from "@punch-bot/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @punch-bot/cli.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@punch-bot/agent": bundledPiAgentCore,
	"@punch-bot/tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@punch-bot/ai": bundledPiAiCompat,
	"@punch-bot/ai/compat": bundledPiAiCompat,
	"@punch-bot/ai/oauth": bundledPiAiOauth,
	"@punch-bot/ai/providers/all": bundledPiAiProviders,
	"@punch-bot/cli": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
