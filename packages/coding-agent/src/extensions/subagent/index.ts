/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { delegateToA2aAgentPreferStream } from "@punch-bot/a2a";
import type { AgentToolResult, ThinkingLevel } from "@punch-bot/agent";
import type { Message } from "@punch-bot/ai";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../../core/tools/truncate.ts";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TRUNCATION_NOTICE_RESERVE = 256;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface SingleResult {
	agent: string;
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	status: ChildStatus;
	exitCode: number | null;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	isError: boolean;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

function getFailureEvidence(result: SingleResult): string {
	const evidence: string[] = [];
	const seen = new Set<string>();
	const add = (label: string, value: string | undefined) => {
		const text = value?.trim();
		if (!text || seen.has(text)) return;
		seen.add(text);
		evidence.push(`${label}: ${text}`);
	};

	add("Error", result.errorMessage);
	add("Signal", result.terminationSignal);
	add("stderr", result.stderr);
	add("Assistant output", getFinalOutput(result.messages));
	return evidence.join("\n\n") || "(no output)";
}

function getResultOutput(result: SingleResult): string {
	return isFailedResult(result) ? getFailureEvidence(result) : getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function truncateModelOutput(output: string): string {
	const initial = truncateHead(output);
	if (!initial.truncated) return output;

	const body = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - TRUNCATION_NOTICE_RESERVE,
	});
	const omittedBytes = initial.totalBytes - body.outputBytes;
	const notice = `[Output truncated: ${omittedBytes} bytes omitted. Full output preserved in tool details.]`;
	return body.content ? `${body.content}\n\n${notice}` : notice;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	// Bun-compiled binaries report their embedded entry as argv[1]: "/$bunfs/root/..." on
	// POSIX and "B:/~BUN/root/..." on Windows. fs.existsSync() resolves these inside Bun.
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: Error;
}

interface ResolvedAgent {
	agent?: AgentConfig;
	available: AgentConfig[];
	cwd: string;
}

function resolveAgent(defaultCwd: string, scope: AgentScope, name: string, cwd?: string): ResolvedAgent {
	const effectiveCwd = path.resolve(defaultCwd, cwd ?? ".");
	const discovery = discoverAgents(effectiveCwd, scope);
	return {
		agent: discovery.agents.find((candidate) => candidate.name === name),
		available: discovery.agents,
		cwd: effectiveCwd,
	};
}

function createUnstartedResult(
	agent: string,
	task: string,
	step: number | undefined,
	status: "aborted" | "failed",
	errorMessage?: string,
): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		status,
		exitCode: null,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage,
		step,
	};
}

async function runSingleAgent(
	dispatchDefaults: DispatchDefaults,
	resolvedAgent: ResolvedAgent,
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	if (signal?.aborted) {
		return createUnstartedResult(agentName, task, step, "aborted", "Subagent was aborted before starting");
	}

	const effectiveCwd = resolvedAgent.cwd;
	const agent = resolvedAgent.agent;
	if (!agent) {
		const available = resolvedAgent.available.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		return createUnstartedResult(
			agentName,
			task,
			step,
			"failed",
			`Unknown agent: "${agentName}". Available agents: ${available}.`,
		);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		status: "running",
		exitCode: null,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		if (agent.a2aUrl) {
			const prompt = agent.systemPrompt.trim() ? `${agent.systemPrompt.trim()}\n\nTask: ${task}` : `Task: ${task}`;
			try {
				const result = await delegateToA2aAgentPreferStream(
					{
						url: agent.a2aUrl,
						task: prompt,
						signal,
					},
					(text) => {
						currentResult.messages = [
							{
								role: "assistant",
								content: [{ type: "text", text }],
							} as Message,
						];
						emitUpdate();
					},
				);
				if (result.failed) {
					currentResult.exitCode = 1;
					currentResult.stderr = result.error ?? "A2A delegation failed";
					currentResult.stopReason = "error";
					currentResult.errorMessage = currentResult.stderr;
					currentResult.status = "failed";
				} else {
					if (result.text) {
						currentResult.messages = [
							{
								role: "assistant",
								content: [{ type: "text", text: result.text }],
							} as Message,
						];
					}
					currentResult.exitCode = 0;
					currentResult.status = "completed";
				}
			} catch (error) {
				if (signal?.aborted) {
					throw error;
				}
				currentResult.exitCode = 1;
				currentResult.stderr = error instanceof Error ? error.message : String(error);
				currentResult.stopReason = "error";
				currentResult.errorMessage = currentResult.stderr;
				currentResult.status = "failed";
			}
			emitUpdate();
			return currentResult;
		}

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		if (signal?.aborted) {
			currentResult.status = "aborted";
			currentResult.errorMessage = "Subagent was aborted before starting";
			return currentResult;
		}

		args.push(`Task: ${task}`);
		emitUpdate();
		let wasAborted = false;
		const outcome = await new Promise<ProcessOutcome>((resolve) => {
			const invocation = getPiInvocation(args);
			let settled = false;
			let exited = false;
			let closed = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: JsonAgentSessionEvent;
				try {
					event = JSON.parse(line) as JsonAgentSessionEvent;
				} catch {
					return;
				}
				if (event.type !== "message_end") return;
				const eventMessage = event.message;
				if (
					eventMessage.role !== "user" &&
					eventMessage.role !== "assistant" &&
					eventMessage.role !== "toolResult"
				) {
					return;
				}
				const message = eventMessage as Message;
				currentResult.messages.push(message);
				if (message.role === "assistant") {
					currentResult.usage.turns++;
					currentResult.usage.input += message.usage.input;
					currentResult.usage.output += message.usage.output;
					currentResult.usage.cacheRead += message.usage.cacheRead;
					currentResult.usage.cacheWrite += message.usage.cacheWrite;
					currentResult.usage.cost += message.usage.cost.total;
					currentResult.usage.contextTokens = message.usage.totalTokens;
					if (!currentResult.model) currentResult.model = message.model;
					currentResult.stopReason = message.stopReason;
					currentResult.errorMessage = message.errorMessage;
				}
				emitUpdate();
			};

			let proc: ReturnType<typeof spawn>;
			const finish = (result: ProcessOutcome) => {
				if (settled) return;
				settled = true;
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", abortProcess);
				resolve(result);
			};
			const abortProcess = () => {
				if (closed || exited || proc.exitCode !== null || proc.signalCode !== null) return;
				if (!proc.kill("SIGTERM")) return;
				wasAborted = true;
				killTimer = setTimeout(() => {
					if (!closed && !exited) proc.kill("SIGKILL");
				}, 5000);
			};

			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: effectiveCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				finish({
					code: null,
					signal: null,
					spawnError: error instanceof Error ? error : new Error(String(error)),
				});
				return;
			}

			proc.stdout?.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr?.on("data", (data) => {
				currentResult.stderr += data.toString();
			});
			proc.on("exit", () => {
				exited = true;
			});
			proc.on("close", (code, terminationSignal) => {
				if (buffer.trim()) processLine(buffer);
				finish({ code, signal: terminationSignal });
			});
			proc.on("error", (error) => {
				finish({ code: null, signal: null, spawnError: error });
			});

			if (signal) {
				if (signal.aborted) abortProcess();
				else signal.addEventListener("abort", abortProcess, { once: true });
			}
		});

		currentResult.exitCode = outcome.code;
		currentResult.terminationSignal = outcome.signal ?? undefined;

		if (wasAborted) {
			currentResult.status = "aborted";
			currentResult.errorMessage ||= "Subagent was aborted";
		} else if (outcome.spawnError) {
			currentResult.status = "failed";
			currentResult.errorMessage = `Failed to spawn subagent: ${outcome.spawnError.message}`;
		} else if (outcome.signal) {
			currentResult.status = "failed";
			currentResult.errorMessage ||= `Subagent terminated by signal ${outcome.signal}`;
		} else if (outcome.code !== 0) {
			currentResult.status = "failed";
			currentResult.errorMessage ||= `Subagent exited with code ${outcome.code}`;
		} else if (currentResult.stopReason === "aborted") {
			currentResult.status = "aborted";
		} else if (currentResult.stopReason === "error") {
			currentResult.status = "failed";
		} else {
			currentResult.status = "completed";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	// Tool execute results cannot set runtime error state directly, so patch it through the result hook.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.isError) return { isError: true };
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain", forceError = false) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					results,
					isError: forceError || results.some(isFailedResult),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single", true)([]),
				};
			}

			const resolvedChain = (params.chain ?? []).map((step) =>
				resolveAgent(ctx.cwd, agentScope, step.agent, step.cwd),
			);
			const resolvedTasks = (params.tasks ?? []).map((task) =>
				resolveAgent(ctx.cwd, agentScope, task.agent, task.cwd),
			);
			const resolvedSingle = params.agent ? resolveAgent(ctx.cwd, agentScope, params.agent, params.cwd) : undefined;

			// Project agents are repo-controlled prompts. Outside the session's trusted project only the user can approve
			// them, never the model: a prompt-injected model picks the agent, its cwd and any option the tool offers.
			if (agentScope === "project" || agentScope === "both") {
				let selectedAgents: ResolvedAgent[] = [];
				if (hasChain) selectedAgents = resolvedChain;
				else if (hasTasks) selectedAgents = resolvedTasks;
				else if (resolvedSingle) selectedAgents = [resolvedSingle];
				const projectAgentsByPath = new Map<string, AgentConfig>();
				for (const resolved of selectedAgents) {
					if (resolved.agent?.source === "project") {
						projectAgentsByPath.set(resolved.agent.filePath, resolved.agent);
					}
				}

				const trustedProjectAgentsDir =
					ctx.isProjectTrusted() && discovery.projectAgentsDir
						? fs.realpathSync(discovery.projectAgentsDir)
						: undefined;
				const projectAgentsRequested = Array.from(projectAgentsByPath.values()).filter(
					(agent) =>
						!trustedProjectAgentsDir || fs.realpathSync(path.dirname(agent.filePath)) !== trustedProjectAgentsDir,
				);
				if (projectAgentsRequested.length > 0) {
					const sources = projectAgentsRequested.map((agent) => `- ${agent.name}: ${agent.filePath}`).join("\n");
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text",
									text: `Refused: project-local agents from an untrusted project need approval in a UI, or the project must be trusted.\nSources:\n${sources}`,
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single", true)([]),
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Sources:\n${sources}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						dispatchDefaults,
						resolvedChain[i],
						step.agent,
						taskWithContext,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: truncateModelOutput(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`),
								},
							],
							details: makeDetails("chain")(results),
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text: truncateModelOutput(getFinalOutput(results[results.length - 1].messages) || "(no output)"),
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel", true)([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						status: "pending",
						exitCode: null,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((result) => result.status === "running").length;
						const pending = allResults.filter((result) => result.status === "pending").length;
						const done = allResults.length - running - pending;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${pending} pending...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						dispatchDefaults,
						resolvedTasks[index],
						t.agent,
						t.task,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status =
						isFailedResult(r) && r.stopReason && r.stopReason !== "end"
							? `${r.status} (${r.stopReason})`
							: r.status;
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task && resolvedSingle) {
				const result = await runSingleAgent(
					dispatchDefaults,
					resolvedSingle,
					params.agent,
					params.task,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: truncateModelOutput(`Agent ${result.stopReason || result.status}: ${errorMsg}`),
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: truncateModelOutput(getFinalOutput(result.messages) || "(no output)"),
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single", true)([]),
			};
		},
	});
}
