import { BACKGROUND_CONTEXT, type Context } from "@punch-bot/agent";
import { decodeServiceControlCall, type JsonValue } from "@punch-bot/chord";
import type { Client } from "@punch-bot/client";
import { getPrincipal, withPrincipal } from "../principal.ts";
import { RuntimeSessions } from "../services.ts";
import type { RoutedSessionAttachment, RoutedSessionHandle } from "../types.ts";
import type { SupervisorClient } from "./control.ts";
import { connectSandboxRuntime } from "./remote-client.ts";

/** A routing handle owns connections only. The sandbox owns every admitted operation. */
export function createRemoteSessionHandle(options: {
	readonly supervisor: Pick<SupervisorClient, "acquire" | "inspect">;
	readonly sandboxId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	authorize(context: Context): Promise<void>;
}): RoutedSessionHandle {
	let closed = false;
	let terminate!: (error: Error | undefined) => void;
	const terminated = new Promise<Error | undefined>((resolve) => {
		terminate = resolve;
	});
	const attachments = new Set<RoutedSessionAttachment>();
	const opening = new Set<Promise<RoutedSessionAttachment>>();
	let closing: Promise<void> | undefined;
	const attach = async (context: Context): Promise<RoutedSessionAttachment> => {
		if (closed) throw new Error("Sandbox session route closed");
		const principal = getPrincipal(context);
		if (!principal || principal.workspaceId !== options.workspaceId) throw new Error("Session access denied");
		const identity = getPrincipal(withPrincipal(principal, BACKGROUND_CONTEXT))!;
		await options.authorize(context);
		const route = await options.supervisor.acquire(options.sandboxId, identity.workspaceId);
		if (route.sandboxId !== options.sandboxId) throw new Error("Supervisor returned the wrong sandbox");
		if (closed) throw new Error("Sandbox session route closed");
		const client = await connectSandboxRuntime(route, identity);
		const subscriptions = new Map<string, ReturnType<Client["subscribeService"]>>();
		let released = false;
		let releasing: Promise<void> | undefined;
		let terminateAttachment!: (error: Error) => void;
		const terminated = new Promise<Error>((resolve) => {
			terminateAttachment = resolve;
		});
		const removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			if (state === "disconnected" && !released) {
				terminateAttachment(
					error ?? new Error("Sandbox runtime disconnected; reattach to reacquire its current generation"),
				);
				void Promise.resolve(attachment.release(context)).catch(() => {});
			}
		});
		const attachment: RoutedSessionAttachment = {
			terminated,
			async invokeService(call, publish, ctx) {
				if (released || closed) throw new Error("Sandbox session route closed");
				const caller = getPrincipal(ctx);
				if (caller?.userId !== identity.userId || caller.workspaceId !== identity.workspaceId)
					throw new Error("Session identity changed");
				await options.authorize(ctx);
				const current = await options.supervisor.inspect(options.sandboxId, identity.workspaceId);
				if (current.generation !== route.generation || current.desired !== "running" || current.state !== "ready")
					throw new Error("Sandbox runtime route is stale");
				const target = client.attachment;
				if (!target || released || closed) throw new Error("Sandbox session detached");
				const control = decodeServiceControlCall(call);
				if (control?.type === "subscribe") {
					if (subscriptions.has(control.subscriptionId)) throw new Error("Duplicate session subscription");
					const pending = client.subscribeService(
						target,
						control.serviceId,
						control.mode,
						async (update) => {
							if (released) return;
							try {
								await options.authorize(context);
								if (!released) await publish(control.subscriptionId, update, context);
							} catch {
								// A revoked subscriber must not receive later updates, even without another RPC.
								terminateAttachment(new Error("Session access revoked"));
								void Promise.resolve(attachment.release(context)).catch(() => {});
							}
						},
						ctx.abortSignal,
					);
					subscriptions.set(control.subscriptionId, pending);
					try {
						const subscription = await pending;
						if (released) {
							await subscription.dispose();
							throw new Error("Session released while subscribing");
						}
						subscription.start();
						return subscription.snapshot as unknown as JsonValue;
					} catch (error) {
						subscriptions.delete(control.subscriptionId);
						throw error;
					}
				}
				if (control?.type === "unsubscribe") {
					const subscription = subscriptions.get(control.subscriptionId);
					subscriptions.delete(control.subscriptionId);
					if (subscription) await (await subscription).dispose();
					return;
				}
				return client.request(target, call, ctx.abortSignal);
			},
			release() {
				released = true;
				releasing ??= (async () => {
					removeConnectionListener();
					await client.dispose();
					await Promise.allSettled(
						[...subscriptions.values()].map(async (subscription) => (await subscription).dispose()),
					);
					subscriptions.clear();
					attachments.delete(attachment);
				})();
				return releasing;
			},
		};
		try {
			await client.request(
				{ serverId: options.sandboxId },
				{ serviceId: RuntimeSessions.id, member: "attach", args: [options.sessionId] },
				context.abortSignal,
			);
			if (closed) throw new Error("Sandbox route closed during attachment");
			attachments.add(attachment);
			return attachment;
		} catch (error) {
			await attachment.release(context);
			throw error;
		}
	};
	return {
		terminated,
		attachClient(context) {
			const pending = attach(context);
			opening.add(pending);
			void pending.finally(() => opening.delete(pending)).catch(() => {});
			return pending;
		},
		close(context) {
			closed = true;
			closing ??= (async () => {
				await Promise.allSettled(opening);
				const results = await Promise.allSettled([...attachments].map((attachment) => attachment.release(context)));
				terminate(undefined);
				const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (errors.length) throw new AggregateError(errors, "Remote session cleanup failed");
			})();
			return closing;
		},
	};
}
