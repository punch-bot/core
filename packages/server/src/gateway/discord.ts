import { createPublicKey, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { LaneTranscriptSnapshot } from "@punch-bot/agent";
import type { JsonValue } from "@punch-bot/chord";
import type { Principal } from "../principal.ts";
import { type ConversationKey, conversationKey } from "./store.ts";
import type { GatewayAdapterHost as Gateway, GatewayCommand, GatewayPresentation, PlatformAdapter } from "./types.ts";

export interface DiscordAdapterOptions {
	readonly applicationId: string;
	readonly publicKey: string;
	readonly botToken: string;
	/** Called only after signature verification. Check installation, thread and user membership. */
	resolvePrincipal(
		identity: { guildId: string; channelId: string; userId: string },
		signal: AbortSignal,
	): Promise<Principal>;
	onError(error: unknown): void;
	readonly fetch?: typeof fetch;
	readonly streaming?: boolean;
	readonly maxConcurrentInteractions?: number;
}

/** Signed Discord interaction endpoint. Register /punch in Discord using DISCORD_COMMAND. */
export class DiscordAdapter implements PlatformAdapter {
	readonly #options: DiscordAdapterOptions;
	readonly #publicKey;
	readonly #controller = new AbortController();
	readonly #tasks = new Set<Promise<void>>();
	readonly #presentations = new Set<GatewayPresentation>();
	readonly #renderers = new Map<string, { renderer: DiscordRenderer; users: number }>();
	#gateway?: Gateway;
	#stopped = false;
	constructor(options: DiscordAdapterOptions) {
		if (!/^[a-f\d]{64}$/i.test(options.publicKey)) throw new TypeError("Discord public key must be 32 hex bytes");
		snowflake(options.applicationId);
		if (
			!options.botToken ||
			!Number.isSafeInteger(options.maxConcurrentInteractions ?? 128) ||
			(options.maxConcurrentInteractions ?? 128) <= 0
		)
			throw new TypeError("Invalid Discord adapter limits or credentials");
		this.#options = options;
		this.#publicKey = createPublicKey({
			key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(options.publicKey, "hex")]),
			format: "der",
			type: "spki",
		});
	}
	async start(gateway: Gateway): Promise<void> {
		if (this.#gateway || this.#stopped) throw new Error("Discord adapter already started or stopped");
		this.#gateway = gateway;
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#controller.abort();
		await Promise.allSettled([...this.#presentations].map((presentation) => presentation.close()));
		await Promise.allSettled(this.#tasks);
	}
	/** Mount on a Node HTTP server's request handler at a caller-selected path. */
	async handleNode(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const headers = new Headers();
		for (const name of ["x-signature-ed25519", "x-signature-timestamp"]) {
			const value = request.headers[name];
			if (typeof value === "string") headers.set(name, value);
		}
		try {
			const init: RequestInit & { duplex: "half" } = { method: request.method, headers, duplex: "half" };
			if (request.method === "POST") init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
			const result = await this.handle(new Request("http://localhost/discord", init));
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch (error) {
			this.#reportError(error);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	}
	async handle(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (!this.#gateway || this.#stopped) return new Response(null, { status: 503 });
		const timestamp = request.headers.get("x-signature-timestamp") ?? "";
		const signature = request.headers.get("x-signature-ed25519") ?? "";
		if (
			!/^\d+$/.test(timestamp) ||
			!/^[a-f\d]{128}$/i.test(signature) ||
			Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000
		) {
			return new Response(null, { status: 401 });
		}
		const reader = request.body?.getReader();
		if (!reader) return new Response(null, { status: 400 });
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > 65_536) {
					await reader.cancel();
					return new Response(null, { status: 413 });
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		const body = Buffer.concat(chunks);
		if (
			!verify(null, Buffer.concat([Buffer.from(timestamp), body]), this.#publicKey, Buffer.from(signature, "hex"))
		) {
			return new Response(null, { status: 401 });
		}
		let interaction: Record<string, unknown>;
		let command: GatewayCommand;
		try {
			interaction = object(JSON.parse(body.toString("utf8")));
			if (interaction.application_id !== this.#options.applicationId) throw new Error("Wrong application");
			if (interaction.type === 1) return Response.json({ type: 1 });
			command = parseCommand(interaction);
			const channel = object(interaction.channel);
			if (![10, 11, 12].includes(Number(channel.type))) throw new Error("Use /punch inside a Discord thread");
			snowflake(interaction.id);
			snowflake(interaction.guild_id);
			snowflake(interaction.channel_id);
			snowflake(object(object(interaction.member).user).id);
			if (typeof interaction.token !== "string" || !interaction.token) throw new Error("Missing interaction token");
		} catch {
			return Response.json({
				type: 4,
				data: { content: "Use a valid /punch command inside a server thread.", flags: 64 },
			});
		}
		if (this.#stopped) return new Response(null, { status: 503 });
		// abort and status bypass the cap so saturated prompt tasks cannot starve control commands.
		if (
			command.type !== "abort" &&
			command.type !== "status" &&
			this.#tasks.size >= (this.#options.maxConcurrentInteractions ?? 128)
		)
			return new Response(null, { status: 429 });
		const task = this.#dispatch(interaction, command).catch((error: unknown) => this.#reportError(error));
		this.#tasks.add(task);
		void task.finally(() => this.#tasks.delete(task)).catch(() => {});
		return Response.json({ type: 5, data: { flags: 64 } });
	}
	async #dispatch(interaction: Record<string, unknown>, command: GatewayCommand): Promise<void> {
		const channelId = snowflake(interaction.channel_id);
		const key: ConversationKey = {
			platform: "discord",
			installationId: snowflake(interaction.guild_id),
			conversationId: channelId,
		};
		const token = String(interaction.token);
		let presentation: GatewayPresentation | undefined;
		let rendererKey: string | undefined;
		try {
			const principal = await abortable(
				this.#options.resolvePrincipal(
					{
						guildId: key.installationId,
						channelId,
						userId: snowflake(object(object(interaction.member).user).id),
					},
					this.#controller.signal,
				),
				this.#controller.signal,
			);
			if (this.#stopped) return;
			const gateway = this.#gateway!;
			rendererKey = conversationKey(principal, key);
			let entry = this.#renderers.get(rendererKey);
			if (!entry) {
				entry = {
					users: 0,
					renderer: new DiscordRenderer(
						gateway,
						principal,
						key,
						(method, path, body) => this.#request(method, path, body),
						this.#options.streaming ?? true,
						this.#controller.signal,
					),
				};
				this.#renderers.set(rendererKey, entry);
			}
			entry.users += 1;
			const renderer = entry.renderer;
			presentation = await gateway.open({
				principal,
				conversation: key,
				send: (event) => renderer.update(event.sessionId, event.snapshot),
			});
			this.#presentations.add(presentation);
			if (this.#stopped) return;
			const result = await presentation.execute(snowflake(interaction.id), command);
			await renderer.flush();
			await this.#reply(token, JSON.stringify(result));
		} catch (error) {
			this.#reportError(error);
			if (!this.#stopped)
				await this.#reply(token, "Command failed. Check session status before sending a new request.");
		} finally {
			if (presentation) {
				this.#presentations.delete(presentation);
				await presentation.close();
			}
			if (rendererKey) {
				const entry = this.#renderers.get(rendererKey);
				if (entry && --entry.users === 0) this.#renderers.delete(rendererKey);
			}
		}
	}
	async #reply(token: string, content: string): Promise<void> {
		await this.#request(
			"PATCH",
			`/webhooks/${this.#options.applicationId}/${encodeURIComponent(token)}/messages/@original`,
			{ content: content.slice(0, 2000), allowed_mentions: { parse: [] } },
		);
	}
	#reportError(error: unknown): void {
		try {
			this.#options.onError(error);
		} catch {
			/* Error observers do not own adapter lifecycle. */
		}
	}
	async #request(method: string, path: string, body: JsonValue): Promise<Record<string, unknown>> {
		const send = this.#options.fetch ?? fetch;
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await send(`https://discord.com/api/v10${path}`, {
				method,
				headers: { Authorization: `Bot ${this.#options.botToken}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(15_000)]),
			});
			const result = object(await response.json());
			if (
				response.status === 429 &&
				typeof result.retry_after === "number" &&
				result.retry_after >= 0 &&
				result.retry_after <= 60
			) {
				await delay(Math.ceil(result.retry_after * 1000), undefined, { signal: this.#controller.signal });
				continue;
			}
			if (!response.ok) throw new Error(`Discord request failed with HTTP ${response.status}`);
			return result;
		}
		throw new Error("Discord rate limit retry budget exhausted");
	}
}

type DiscordRequest = (method: string, path: string, body: JsonValue) => Promise<Record<string, unknown>>;

class DiscordRenderer {
	readonly #gateway: Gateway;
	readonly #principal: Principal;
	readonly #key: ConversationKey;
	readonly #request: (method: string, path: string, body: JsonValue) => Promise<Record<string, unknown>>;
	readonly #streaming: boolean;
	readonly #signal: AbortSignal;
	readonly #seen = new Map<string, string>();
	readonly #initialized = new Set<string>();
	readonly #streamIds = new Map<string, string>();
	readonly #failed = new Set<string>();
	#latest?: { sessionId: string; snapshot: LaneTranscriptSnapshot };
	#writing?: Promise<void>;
	#lastWrite = 0;
	constructor(
		gateway: Gateway,
		principal: Principal,
		key: ConversationKey,
		request: DiscordRequest,
		streaming: boolean,
		signal: AbortSignal,
	) {
		this.#gateway = gateway;
		this.#principal = principal;
		this.#key = key;
		this.#request = request;
		this.#streaming = streaming;
		this.#signal = signal;
	}
	async update(sessionId: string, snapshot: LaneTranscriptSnapshot): Promise<void> {
		if (!this.#initialized.has(sessionId)) {
			this.#initialized.add(sessionId);
			for (const entry of snapshot.transcript) {
				if (entry.type === "message" && entry.message.role === "assistant")
					this.#seen.set(`${sessionId}:${entry.id}`, "history");
			}
		}
		this.#latest = { sessionId, snapshot };
		await this.flush();
	}
	async flush(): Promise<void> {
		if (this.#writing) return this.#writing;
		this.#writing = this.#drain().finally(() => {
			this.#writing = undefined;
		});
		return this.#writing;
	}
	async #drain(): Promise<void> {
		while (this.#latest) {
			await delay(Math.max(0, 1000 - (Date.now() - this.#lastWrite)), undefined, { signal: this.#signal });
			const { sessionId, snapshot } = this.#latest;
			this.#latest = undefined;
			const messages = snapshot.transcript.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? [{ id: `${sessionId}:${entry.id}`, message: entry.message }]
					: [],
			);
			let activeId: string | undefined;
			const operationId = snapshot.operation?.id ?? snapshot.lastResult?.operationId;
			const operationKey = operationId ? `${sessionId}:${operationId}` : undefined;
			if (this.#streaming && snapshot.operation?.streamingMessage) {
				const message = snapshot.operation.streamingMessage;
				const id = `${sessionId}:stream:${snapshot.operation.id}`;
				this.#streamIds.set(`${sessionId}:${snapshot.operation.id}`, id);
				messages.push({ id, message });
				activeId = id;
			}
			for (const { id, message } of messages) {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				if (!text || this.#failed.has(id) || this.#seen.get(id) === "history" || this.#seen.get(id) === text)
					continue;
				let part = 0;
				try {
					for (let offset = 0; offset < text.length; ) {
						let end = Math.min(offset + 2000, text.length);
						if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
						const outputId = `${id}:${part}`;
						const streamId = operationKey ? this.#streamIds.get(operationKey) : undefined;
						const messageId =
							this.#gateway.store.message(this.#principal, this.#key, outputId) ??
							(streamId
								? this.#gateway.store.message(this.#principal, this.#key, `${streamId}:${part}`)
								: undefined);
						part++;
						const result = await this.#request(
							messageId ? "PATCH" : "POST",
							`/channels/${this.#key.conversationId}/messages${messageId ? `/${messageId}` : ""}`,
							{
								content: text.slice(offset, end),
								allowed_mentions: { parse: [] },
								components:
									id === activeId
										? [
												{
													type: 1,
													components: [{ type: 2, style: 2, label: "Abort", custom_id: "punch:abort" }],
												},
											]
										: [],
							},
						);
						this.#gateway.store.recordMessage(
							this.#principal,
							this.#key,
							outputId,
							messageId ?? snowflake(result.id),
						);
						offset = end;
					}
				} catch (error) {
					// Suppress replay of failed output: a timed-out POST may have been
					// accepted, and resending it later would duplicate the message.
					this.#failed.add(id);
					throw error;
				}
				this.#seen.set(id, text);
			}
			if (!snapshot.operation && operationKey) this.#streamIds.delete(operationKey);
			this.#lastWrite = Date.now();
		}
	}
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("Discord adapter stopped"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error("Discord adapter stopped"));
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}
function snowflake(value: unknown): string {
	if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new Error("Invalid Discord ID");
	return value;
}
function parseCommand(interaction: Record<string, unknown>): GatewayCommand {
	const data = object(interaction.data);
	if (interaction.type === 3 && data.custom_id === "punch:abort") return { type: "abort" };
	if (interaction.type !== 2 || data.name !== "punch" || !Array.isArray(data.options) || data.options.length !== 1)
		throw new Error("Unknown command");
	const subcommand = object(data.options[0]);
	const values = new Map<string, string>();
	for (const option of Array.isArray(subcommand.options) ? subcommand.options : []) {
		const value = object(option);
		if (typeof value.name !== "string" || typeof value.value !== "string") throw new Error("Invalid command option");
		values.set(value.name, value.value);
	}
	const required = (name: string): string => {
		const value = values.get(name);
		if (!value) throw new Error(`Missing ${name}`);
		return value;
	};
	switch (subcommand.name) {
		case "prompt":
			return { type: "prompt", text: required("text") };
		case "new":
		case "abort":
		case "status":
			return { type: subcommand.name };
		case "attach":
			return { type: "attach", sessionId: required("session") };
		case "model":
			return { type: "model", model: { provider: required("provider"), modelId: required("model") } };
		default:
			throw new Error("Unknown subcommand");
	}
}

export const DISCORD_COMMAND = {
	name: "punch",
	description: "Control the Punch session in this thread",
	type: 1,
	options: [
		{
			type: 1,
			name: "prompt",
			description: "Send a prompt",
			options: [{ type: 3, name: "text", description: "Prompt", required: true, max_length: 32000 }],
		},
		{ type: 1, name: "abort", description: "Abort the current turn" },
		{ type: 1, name: "status", description: "Show session and model" },
		{ type: 1, name: "new", description: "Start a new session" },
		{
			type: 1,
			name: "attach",
			description: "Attach an existing session",
			options: [{ type: 3, name: "session", description: "Session ID", required: true }],
		},
		{
			type: 1,
			name: "model",
			description: "Select a model",
			options: [
				{ type: 3, name: "provider", description: "Provider", required: true },
				{ type: 3, name: "model", description: "Model ID", required: true },
			],
		},
	],
};
