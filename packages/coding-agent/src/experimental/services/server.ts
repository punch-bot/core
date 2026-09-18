import {
	type Context,
	createRemoteServiceEndpoint,
	type JsonValue,
	type MutableReplicatedState,
	RemoteServiceProvider,
	replicatedState,
} from "@punch-bot/chord";
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import type { RoutedServerServiceAttachment, RoutedServerServiceHost } from "@punch-bot/server";
import { PresentationPlugins } from "./plugins.ts";
import {
	type SessionCreateOptions,
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "./sessions.ts";

export interface ExperimentalServerServices {
	readonly host: RoutedServerServiceHost;
	refresh(context?: Context): Promise<void>;
	dispose(): Promise<void>;
}

export type SessionPermission =
	| "sessions:read"
	| "sessions:create"
	| "sessions:control"
	| "sessions:remove"
	| "plugins:manage";

export interface SessionAccess {
	canAccess(permission: SessionPermission, sessionId: string | undefined, context: Context): Promise<boolean>;
	authorize(permission: SessionPermission, sessionId: string | undefined, context: Context): Promise<void>;
	created(sessionId: string, context: Context): Promise<void>;
	removed(sessionId: string, context: Context): Promise<void>;
}

export async function createExperimentalServerServices(options: {
	access?: SessionAccess;
	list(context: Context): Promise<SessionSummary[]>;
	create(createOptions: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	prepareSessionPlugins(
		sessionId: string,
		packagePaths: readonly string[] | undefined,
		context: Context,
	): Promise<{ readonly packagePaths: readonly string[]; readonly presentationPlugins: JsonValue }>;
	reloadPresentationPlugins(packagePaths: readonly string[], context: Context): Promise<JsonValue>;
}): Promise<ExperimentalServerServices> {
	let revision = 1;
	let disposed = false;
	const attachments = new Set<RoutedServerServiceAttachment>();
	const directories = new Map<
		RoutedServerServiceAttachment,
		{ context: Context; state: MutableReplicatedState<SessionDirectoryState> }
	>();
	let mutationTail = Promise.resolve();
	const list = async (context: Context): Promise<SessionSummary[]> => {
		const sessions = await options.list(context);
		if (!options.access) return sessions;
		const allowed = await Promise.all(
			sessions.map((session) => options.access!.canAccess("sessions:read", session.sessionId, context)),
		);
		return sessions.filter((_, index) => allowed[index]);
	};

	const refreshNow = async (context: Context): Promise<void> => {
		revision += 1;
		await Promise.allSettled(
			[...directories.values()].map(async (directory) => {
				directory.state.state.sessions = await list(directory.context);
				directory.state.state.revision = revision;
				directory.state.publish(context);
			}),
		);
	};
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		if (disposed) return Promise.reject(new Error("Server services are disposed"));
		const result = mutationTail.catch(() => {}).then(operation);
		mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	return {
		host: {
			attachClient(presentation, context) {
				return serialize(async () => {
					if (disposed) throw new Error("Server services are disposed");
					const directory = replicatedState<SessionDirectoryState>({ revision, sessions: await list(context) });
					let preparedPluginPackagePaths: readonly string[] | undefined;
					const provider = new RemoteServiceProvider([
						{ service: SessionDirectory, mode: "singleton" },
						{ service: SessionManagement, mode: "singleton" },
						{ service: PresentationPlugins, mode: "singleton" },
					]);
					provider.provide(SessionDirectory, { state: directory });
					provider.provide(PresentationPlugins, {
						prepareSession: ({ sessionId, packagePaths }, context) =>
							serialize(async () => {
								await options.access?.authorize("plugins:manage", sessionId, context);
								const selected = await options.prepareSessionPlugins(
									sessionId,
									packagePaths ?? undefined,
									context,
								);
								preparedPluginPackagePaths = selected.packagePaths;
								return selected.presentationPlugins;
							}),
						reload: (context) =>
							serialize(async () => {
								await options.access?.authorize("plugins:manage", undefined, context);
								if (preparedPluginPackagePaths === undefined) {
									throw new Error("No Session plugin selection is prepared");
								}
								return options.reloadPresentationPlugins(preparedPluginPackagePaths, context);
							}),
					});
					provider.provide(SessionManagement, {
						create: (createOptions, context) =>
							serialize(async () => {
								await options.access?.authorize("sessions:create", undefined, context);
								const created = await options.create(createOptions, context);
								await options.access?.created(created.sessionId, context);
								await refreshNow(context);
								return created;
							}),
						remove: (sessionId, context) =>
							serialize(async () => {
								await options.access?.authorize("sessions:remove", sessionId, context);
								await presentation.prepareSessionRemoval(sessionId, context);
								await options.remove(sessionId, context);
								await options.access?.removed(sessionId, context);
								await refreshNow(context);
							}),
						attach: (sessionId, context) =>
							serialize(async () => {
								await options.access?.authorize("sessions:read", sessionId, context);
								await presentation.attachSession(sessionId, context);
							}),
						detach: (context) =>
							serialize(async () => {
								await presentation.detachSession(context);
								preparedPluginPackagePaths = undefined;
							}),
					});
					const attachment = createProviderAttachment(provider, () => {
						attachments.delete(attachment);
						directories.delete(attachment);
					});
					attachments.add(attachment);
					directories.set(attachment, { context, state: directory });
					return attachment;
				});
			},
		},
		refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
		async dispose() {
			disposed = true;
			await mutationTail;
			const releases = await Promise.allSettled(
				[...attachments].map((attachment) => attachment.release(BACKGROUND_CONTEXT)),
			);
			attachments.clear();
			const errors = releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to release server service attachments");
		},
	};
}

function createProviderAttachment(
	provider: RemoteServiceProvider,
	onRelease: () => void,
): RoutedServerServiceAttachment {
	const endpoint = createRemoteServiceEndpoint(provider);
	let released = false;
	return {
		invokeService(call, publish, context) {
			if (released) return Promise.reject(new Error("Server service attachment is released"));
			return endpoint.invoke(call, publish, context);
		},
		release() {
			if (released) return;
			released = true;
			endpoint.dispose();
			provider.dispose();
			onRelease();
		},
	};
}
