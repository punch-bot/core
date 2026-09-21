import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type LaneTranscriptSnapshot } from "@punch-bot/agent";
import { createRemoteServiceBinding, type JsonValue } from "@punch-bot/chord";
import { Client, createClientServiceTransport } from "@punch-bot/client";
import { getPrincipal, withPrincipal } from "../principal.ts";
import type { Server } from "../server.ts";
import { GatewaySessions, RuntimeModels, RuntimeTranscript, SandboxOperations } from "../services.ts";
import { conversationKey, type GatewayStore } from "./store.ts";
import type { GatewayAdapterHost, GatewayPresentation, Presentation } from "./types.ts";

/** Platform commands use the same authenticated services as WebSocket clients. */
export class Gateway implements GatewayAdapterHost {
	readonly store: GatewayStore;
	readonly #server: Server;
	readonly #onError: (error: unknown) => void;
	readonly #presentations = new Set<GatewayPresentation>();
	readonly #active = new Set<Promise<unknown>>();
	readonly #queues = new Map<string, Promise<unknown>>();
	#closed = false;
	#closing?: Promise<void>;
	constructor(options: { server: Server; store: GatewayStore; onError(error: unknown): void }) {
		this.store = options.store;
		this.#server = options.server;
		this.#onError = (error) => {
			try {
				options.onError(error);
			} catch {
				/* Observers cannot interrupt cleanup. */
			}
		};
	}
	open(presentation: Presentation): Promise<GatewayPresentation> {
		return this.#track(this.#open(presentation));
	}
	async #open(presentation: Presentation): Promise<GatewayPresentation> {
		if (this.#closed) throw new Error("Gateway closed");
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
		const managementBinding = createRemoteServiceBinding({
			services: [GatewaySessions],
			transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
			bound: true,
			assertAccess() {},
			onError: this.#onError,
		});
		const binding = createRemoteServiceBinding({
			services: [SandboxOperations, RuntimeTranscript, RuntimeModels],
			transport: createClientServiceTransport(client, () => client.attachment),
			bound: false,
			assertAccess() {},
			onError: this.#onError,
		});
		const management = managementBinding.use(GatewaySessions);
		const operations = binding.use(SandboxOperations);
		const transcript = binding.use(RuntimeTranscript);
		const models = binding.use(RuntimeModels);
		const controller = new AbortController();
		let disposed = false;
		let disposing: Promise<void> | undefined;
		let transition = Promise.resolve();
		const removeAttachment = client.onAttachmentChange((attachment) => {
			transition = binding.rebind(attachment !== undefined, context);
			void transition.catch(this.#onError);
		});
		const removeConnection = client.onConnectionStateChange(({ state }) => {
			if (state === "disconnected") controller.abort(new Error("Gateway connection closed"));
		});
		let output: { sessionId: string; snapshot: LaneTranscriptSnapshot } | undefined;
		let sending: Promise<void> | undefined;
		const flush = (): Promise<void> => {
			if (sending) return sending;
			sending = Promise.resolve()
				.then(async () => {
					while (output && !disposed) {
						const event = output;
						output = undefined;
						await presentation.send({ type: "transcript", ...event });
					}
				})
				.catch(this.#onError)
				.finally(() => {
					sending = undefined;
				});
			return sending;
		};
		const unsubscribe = transcript.state.subscribe((state) => {
			if (state?.snapshot && client.attachment) {
				output = { sessionId: client.attachment.sessionId, snapshot: state.snapshot };
				void flush();
			}
		});
		const waitForCompletion = async (operationId: string): Promise<void> => {
			// Discord interaction tokens last 15 minutes. A timeout detaches only this presentation.
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(14 * 60_000)]);
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				let observed = false;
				let remove: (() => void) | undefined;
				let removeAttachment: (() => void) | undefined;
				const finish = (error?: unknown): void => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", abort);
					remove?.();
					removeAttachment?.();
					if (error) reject(error);
					else resolve();
				};
				const abort = (): void => finish(signal.reason);
				if (signal.aborted) return abort();
				signal.addEventListener("abort", abort, { once: true });
				const target = client.attachment;
				removeAttachment = client.onAttachmentChange((attachment) => {
					if (attachment?.attachmentId !== target?.attachmentId)
						finish(new Error("Runtime attachment lost before transcript completion; inspect session status"));
				});
				remove = transcript.state.subscribe((state) => {
					const snapshot = state?.snapshot;
					if (!snapshot) return;
					if (snapshot.lastResult?.operationId === operationId) return finish();
					if (snapshot.faulted) return finish(new Error("Session faulted before transcript completion"));
					if (snapshot.operation?.id === operationId) {
						observed = true;
						return;
					}
					if (snapshot.operation || observed) finish(new Error("Operation ended without a completion snapshot"));
				});
				if (settled) remove();
			});
		};
		const dispose = (): Promise<void> => {
			if (disposing) return disposing;
			disposed = true;
			controller.abort(new Error("Gateway presentation closed"));
			unsubscribe();
			removeAttachment();
			removeConnection();
			disposing = (async () => {
				try {
					await Promise.allSettled([binding.dispose(context), managementBinding.dispose(context)]);
				} finally {
					await client.dispose();
					await sending;
				}
			})();
			return disposing;
		};
		try {
			await managementBinding.ready(context);
			const attach = async (sessionId: string): Promise<void> => {
				// Always call the host, including for a cached attachment, to recheck authorization.
				await management.attach(sessionId, context);
				await transition;
				await binding.ready(context);
				if (client.attachment?.sessionId !== sessionId) throw new Error("Session attachment changed");
			};
			const handle: GatewayPresentation = {
				execute: (eventId, command) => {
					const run = async (): Promise<JsonValue> => {
						if (disposed || this.#closed) throw new Error("Gateway presentation closed");
						if (!eventId || eventId.length > 256) throw new Error("Invalid platform event ID");
						if (command.type === "prompt" && (!command.text.trim() || command.text.length > 32_000))
							throw new Error("Prompt must contain 1 to 32000 characters");
						await this.store.authorize("sessions:read", undefined, context);
						const receipt = this.store.claim(principal, key, eventId);
						if (receipt) return { duplicate: true, ...receipt };
						let submitted: { sessionId: string; operationId: string } | undefined;
						try {
							let sessionId = this.store.conversation(principal, key);
							let result: JsonValue;
							if (command.type === "attach") {
								await attach(command.sessionId);
								this.store.bind(principal, key, command.sessionId);
								result = { sessionId: command.sessionId };
							} else if (!sessionId && (command.type === "abort" || command.type === "status")) {
								result = { sessionId: null, operation: null };
							} else {
								if (!sessionId || command.type === "new") {
									sessionId = (await management.create(null, context)).sessionId;
									this.store.bind(principal, key, sessionId);
								}
								await attach(sessionId);
								switch (command.type) {
									case "prompt": {
										const operationId = createHash("sha256")
											.update(JSON.stringify([conversationKey(principal, key), eventId]))
											.digest("hex");
										submitted = { sessionId, operationId };
										this.store.recordOperation(principal, key, eventId, sessionId, operationId);
										await operations.accept({ operationId, text: command.text }, context);
										await waitForCompletion(operationId);
										result = { sessionId, operationId, accepted: true };
										break;
									}
									case "abort": {
										const operationId = transcript.state.value?.snapshot?.operation?.id;
										if (operationId) await operations.abort(operationId, context);
										result = { sessionId, aborted: operationId ?? null };
										break;
									}
									case "model":
										await models.select(command.model, context);
										result = { sessionId, model: { ...command.model } };
										break;
									case "status":
										result = {
											sessionId,
											operation: transcript.state.value?.snapshot?.operation?.id ?? null,
											model: transcript.state.value?.snapshot?.configuration.model ?? null,
										};
										break;
									case "new":
										result = { sessionId };
										break;
								}
							}
							await flush();
							this.store.complete(principal, key, eventId, "completed", result);
							return result;
						} catch (error) {
							this.store.complete(principal, key, eventId, "failed", {
								...submitted,
								error: "Command failed; inspect session before retrying",
							});
							throw error;
						}
					};
					if (command.type === "abort" || command.type === "status") return this.#track(run());
					const queueKey = conversationKey(principal, key);
					const result = (this.#queues.get(queueKey) ?? Promise.resolve()).catch(() => {}).then(run);
					this.#queues.set(queueKey, result);
					void result
						.finally(() => {
							if (this.#queues.get(queueKey) === result) this.#queues.delete(queueKey);
						})
						.catch(() => {});
					return this.#track(result);
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
	#track<T>(promise: Promise<T>): Promise<T> {
		this.#active.add(promise);
		void promise.finally(() => this.#active.delete(promise)).catch(() => {});
		return promise;
	}
	close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= (async () => {
			const results = await Promise.allSettled([...this.#presentations].map((presentation) => presentation.close()));
			await Promise.allSettled(this.#active);
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "Gateway shutdown failed");
		})();
		return this.#closing;
	}
}
