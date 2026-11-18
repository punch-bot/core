import * as bundledPiAgentCore from "@punch-bot/agent";
import * as bundledPiAiModels from "@punch-bot/ai/models";
import * as bundledPiAiOauth from "@punch-bot/ai/oauth";
import * as bundledPiAiProviders from "@punch-bot/ai/providers/all";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @punch-bot/cli.
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiExtensionView from "./pi-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@punch-bot/agent": bundledPiAgentCore,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and pi-ai's former TypeBox
	// re-exports keep working.
	"@punch-bot/ai": bundledPiAiExtensionView,
	"@punch-bot/ai/compat": bundledPiAiExtensionView,
	"@punch-bot/ai/models": bundledPiAiModels,
	"@punch-bot/ai/oauth": bundledPiAiOauth,
	"@punch-bot/ai/providers/all": bundledPiAiProviders,
	"@punch-bot/cli": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-ai": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/compat": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/models": bundledPiAiModels,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
