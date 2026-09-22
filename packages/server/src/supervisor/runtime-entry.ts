import { createModels, fauxAssistantMessage, fauxProvider } from "@punch-bot/ai";
import { anthropicProvider } from "@punch-bot/ai/providers/anthropic";
import { openaiProvider } from "@punch-bot/ai/providers/openai";
import { installShutdown, requiredEnvironment as required } from "../deployment/process.ts";
import { startSandboxRuntimeServer } from "./runtime-server.ts";

const models = createModels();
const provider = required("PUNCH_PROVIDER");
if (provider === "faux") {
	const tokensPerSecond =
		process.env.PUNCH_FAUX_TOKENS_PER_SECOND === undefined
			? undefined
			: Number(process.env.PUNCH_FAUX_TOKENS_PER_SECOND);
	if (tokensPerSecond !== undefined && (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0))
		throw new Error("Invalid faux streaming rate");
	const faux = fauxProvider({ tokensPerSecond });
	const respond = () => {
		faux.appendResponses([respond]);
		return fauxAssistantMessage("sandbox smoke answer");
	};
	faux.setResponses([respond]);
	models.setProvider(faux.provider);
} else if (provider === "openai") models.setProvider(openaiProvider());
else if (provider === "anthropic") models.setProvider(anthropicProvider());
else throw new Error(`Unsupported runtime provider: ${provider}`);
const model = models.getModel(provider, required("PUNCH_MODEL"));
if (!model) throw new Error("Configured runtime model is unavailable");
const port = Number(process.env.PUNCH_RUNTIME_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid runtime port");
const runtime = await startSandboxRuntimeServer({
	directory: process.env.PUNCH_SANDBOX_DIRECTORY ?? "/sandbox",
	sandboxId: required("PUNCH_SANDBOX_ID"),
	workspaceId: required("PUNCH_WORKSPACE_ID"),
	generation: required("PUNCH_RUNTIME_GENERATION"),
	token: required("PUNCH_RUNTIME_TOKEN"),
	models,
	model,
	port,
	onError: (error) => console.error(error),
});
console.log(JSON.stringify({ type: "ready", url: runtime.url }));
installShutdown(() => runtime.close(), 8_000);
