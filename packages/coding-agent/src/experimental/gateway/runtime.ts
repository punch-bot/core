import type { LaneTranscriptSnapshot } from "@punch-bot/agent";
import type { Context, JsonValue } from "@punch-bot/chord";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { Client } from "@punch-bot/client";
import { getPrincipal, type Principal, type Server, withPrincipal } from "@punch-bot/server";
import { AgentController } from "../services/agent-controller.ts";
import { createServerServiceSource, createSessionServiceSource } from "../services/connection.ts";
import { type ModelRef, Models } from "../services/models.ts";
import { SessionManagement } from "../services/sessions.ts";
import { Transcript } from "../services/transcript.ts";
import { type ConversationKey, conversationKey, type GatewayStore } from "./store.ts";

const TRANSCRIPT_COMPLETION_TIMEOUT_MS = 10_000;

export type GatewayCommand =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "new" }
	| { type: "attach"; sessionId: string }
	| { type: "model"; model: ModelRef }
	| { type: "status" };

export interface Presentation {
	readonly principal: Principal;
	readonly conversation: ConversationKey;
	send(event: { type: "transcript"; sessionId: string; snapshot: LaneTranscriptSnapshot }): Promise<void>;
}

export interface PlatformAdapter {
	start(gateway: Gateway): Promise<void>;
	stop(): Promise<void>;
}

export interface GatewayPresentation {
	execute(eventId: string, command: GatewayCommand): Promise<JsonValue>;
	close(): Promise<void>;
}

/** Adapters use typed services through an authenticated in-process protocol connection. */
export class Gateway {
	readonly store: GatewayStore;
	readonly #server: Server;
	readonly #onError: (error: unknown) => void;
	readonly #presentations = new Set<GatewayPresentation>();
	readonly #operations = new Map<string, Promise<unknown>>();
	readonly #active = new Set<Promise<unknown>>();
	#closed = false;
	#closing?: Promise<void>;
	constructor(options: { server: Server; store: GatewayStore; onError(error: unknown): void }) {
		this.#server = options.server;
		this.store = options.store;
		this.#onError = (error) => {
			try {
				options.onError(error);
			} catch {
				/* Observers cannot interrupt connection cleanup. */
			}
		};
	}
	open(presentation: Presentation): Promise<GatewayPresentation> {
		return this.#track(this.#open(presentation));
	}
	async #open(presentation: Presentation): Promise<GatewayPresentation> {
		if (this.#closed) throw new Error("Gateway is closed");
		const context = withPrincipal(presentation.principal, BACKGROUND_CONTEXT);
		const principal = getPrincipal(context)!;
		const key = Object.freeze({ ...presentation.conversation });
		await this.store.authorize("sessions:read", undefined, context);
		const client = await Client.connect({
			serverId: this.#server.serverId,
			transportFactory: (handlers) => {
				let closed = false;
				const handler = this.#server.accept(
					{
						get closed() {
							return closed;
						},
						async send(bytes) {
							if (!closed) handlers.onData(bytes.slice());
						},
						close(final) {
							if (closed) return;
							if (final) handlers.onData(final.slice());
							closed = true;
							queueMicrotask(() => {
								handlers.onClose();
								handler.onClose();
							});
						},
					},
					context,
				);
				return {
					async send(bytes) {
						if (closed) throw new Error("Gateway connection closed");
						handler.onData(bytes.slice());
					},
					close() {
						if (!closed) {
							closed = true;
							handler.onClose();
							handlers.onClose();
						}
					},
				};
			},
		});
		const server = createServerServiceSource(client);
		const session = createSessionServiceSource(client);
		const serverServices = server.open({ services: [SessionManagement], assertAccess() {}, onError: this.#onError });
		const services = session.open({
			services: [AgentController, Models, Transcript],
			assertAccess() {},
			onError: this.#onError,
		});
		const management = serverServices.use(SessionManagement);
		const agent = services.use(AgentController);
		const models = services.use(Models);
		const transcript = services.use(Transcript);
		let disposed = false;
		const completionController = new AbortController();
		let lastObservedOperationId: string | undefined;
		let output: { sessionId: string; snapshot: LaneTranscriptSnapshot } | undefined;
		let sending: Promise<void> | undefined;
		const flush = (): Promise<void> => {
			if (sending) return sending;
			sending = Promise.resolve()
				.then(async () => {
					try {
						while (output && !disposed) {
							const event = output;
							output = undefined;
							await presentation.send({ type: "transcript", ...event });
						}
					} catch (error) {
						this.#onError(error);
					}
				})
				.finally(() => {
					sending = undefined;
				});
			return sending;
		};
		const unsubscribe = transcript.state.subscribe((state) => {
			if (state.snapshot?.operation) lastObservedOperationId = state.snapshot.operation.id;
			if (state?.snapshot && client.attachment) {
				output = { sessionId: client.attachment.sessionId, snapshot: state.snapshot };
				void flush();
			}
		});
		const waitForTranscriptCompletion = async (operationId: string): Promise<void> => {
			const inspect = (snapshot: LaneTranscriptSnapshot | null | undefined): true | Error | undefined => {
				if (!snapshot) return;
				if (snapshot.lastResult?.operationId === operationId) return true;
				if (snapshot.faulted) return new Error(`Session faulted before transcript completed ${operationId}`);
				if (snapshot.operation?.id === operationId) {
					lastObservedOperationId = operationId;
					return snapshot.operation.deferred ? true : undefined;
				}
				if (snapshot.operation)
					return new Error(`Operation ${operationId} was replaced before transcript completion`);
				if (lastObservedOperationId === operationId) {
					return new Error(`Operation ${operationId} ended without a completion snapshot`);
				}
			};
			const initial = inspect(transcript.state.value?.snapshot);
			if (initial === true) return;
			if (initial) throw initial;
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				let unsubscribeCompletion: (() => void) | undefined;
				const timeoutSignal = AbortSignal.timeout(TRANSCRIPT_COMPLETION_TIMEOUT_MS);
				const signal = AbortSignal.any([completionController.signal, timeoutSignal]);
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					unsubscribeCompletion?.();
					if (error) reject(error);
					else resolve();
				};
				const onAbort = (): void =>
					finish(
						new Error(
							completionController.signal.aborted
								? "Gateway presentation closed before transcript completion"
								: `Timed out waiting for transcript completion ${operationId}`,
						),
					);
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
				unsubscribeCompletion = transcript.state.subscribe((state) => {
					const result = inspect(state.snapshot);
					if (result === true) finish();
					else if (result) finish(result);
				});
				if (settled) unsubscribeCompletion();
			});
		};
		let disposing: Promise<void> | undefined;
		const dispose = (): Promise<void> => {
			if (disposing) return disposing;
			disposed = true;
			completionController.abort();
			unsubscribe();
			disposing = (async () => {
				try {
					await Promise.all([server.dispose(context), session.dispose(context)]);
				} finally {
					await client.dispose();
					await sending;
				}
			})();
			return disposing;
		};
		try {
			await Promise.all([serverServices.ready(context), services.ready(context)]);
			const attach = async (sessionId: string): Promise<void> => {
				await this.store.authorize("sessions:read", sessionId, context);
				if (client.attachment?.sessionId === sessionId) return;
				await management.attach(sessionId, context);
				await session.whenAttached(sessionId, context);
			};
			const handle: GatewayPresentation = {
				execute: (eventId, command) => {
					const run = async (): Promise<JsonValue> => {
						if (disposed || this.#closed) throw new Error("Gateway presentation closed");
						if (!eventId || eventId.length > 256) throw new Error("Invalid platform event ID");
						if (command.type === "prompt" && (!command.text.trim() || command.text.length > 32_000)) {
							throw new Error("Prompt must contain 1 to 32000 characters");
						}
						await this.store.authorize("sessions:read", undefined, context);
						const receipt = this.store.claim(principal, key, eventId);
						if (receipt) return { duplicate: true, ...receipt };
						try {
							let sessionId = this.store.conversation(principal, key);
							if (command.type === "attach") {
								await attach(command.sessionId);
								this.store.bind(principal, key, command.sessionId);
								const result = { sessionId: command.sessionId };
								this.store.complete(principal, key, eventId, "completed", result);
								return result;
							}
							if (!sessionId && (command.type === "abort" || command.type === "status")) {
								const result = { sessionId: null, operation: null };
								this.store.complete(principal, key, eventId, "completed", result);
								return result;
							}
							if (!sessionId || command.type === "new") {
								const created = await management.create({}, context);
								sessionId = created.sessionId;
								this.store.bind(principal, key, sessionId);
							}
							await attach(sessionId);
							const result = await executeCommand(
								command,
								sessionId,
								agent,
								models,
								transcript,
								waitForTranscriptCompletion,
								context,
							);
							await flush();
							this.store.complete(principal, key, eventId, "completed", result);
							return result;
						} catch (error) {
							this.store.complete(principal, key, eventId, "failed", {
								error: "Command failed; inspect session before retrying",
							});
							throw error;
						}
					};
					// A prompt waits for the entire turn. Abort/status must remain callable during it.
					return this.#track(
						command.type === "abort" || command.type === "status"
							? run()
							: this.#serialize(conversationKey(principal, key), run),
					);
				},
				close: async () => {
					this.#presentations.delete(handle);
					await dispose();
				},
			};
			if (this.#closed) throw new Error("Gateway closed while opening presentation");
			this.#presentations.add(handle);
			return handle;
		} catch (error) {
			await dispose();
			throw error;
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			const results = await Promise.allSettled([...this.#presentations].map((presentation) => presentation.close()));
			await Promise.allSettled(this.#active);
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "Gateway shutdown failed");
		})();
		return this.#closing;
	}
	#track<T>(operation: Promise<T>): Promise<T> {
		this.#active.add(operation);
		void operation.finally(() => this.#active.delete(operation)).catch(() => {});
		return operation;
	}
	#serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const result = (this.#operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
		this.#operations.set(key, result);
		void result
			.finally(() => {
				if (this.#operations.get(key) === result) this.#operations.delete(key);
			})
			.catch(() => {});
		return result;
	}
}

async function executeCommand(
	command: Exclude<GatewayCommand, { type: "attach" }>,
	sessionId: string,
	agent: AgentController,
	models: Models,
	transcript: Transcript,
	waitForTranscriptCompletion: (operationId: string) => Promise<void>,
	context: Context,
): Promise<JsonValue> {
	switch (command.type) {
		case "prompt": {
			const result = await agent.prompt({ message: command.text, images: null }, context);
			if (result.accepted) await waitForTranscriptCompletion(result.operationId);
			return { sessionId, ...result, error: result.error ? { ...result.error } : null };
		}
		case "abort": {
			const operationId = transcript.state.value?.snapshot?.operation?.id;
			if (operationId) await agent.requestAbort(operationId, context);
			return { sessionId, aborted: operationId ?? null };
		}
		case "model":
			await models.select(command.model, context);
			return { sessionId, model: { ...command.model } };
		case "new":
			return { sessionId };
		case "status":
			return {
				sessionId,
				operation: transcript.state.value?.snapshot?.operation?.id ?? null,
				model: models.state.value?.configuration.model ? { ...models.state.value.configuration.model } : null,
			};
	}
}
