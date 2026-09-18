import type { Context } from "@punch-bot/agent";
import type { ServiceStateEncoder } from "@punch-bot/chord";
import type { ClientMessageDecoder, RpcTarget } from "@punch-bot/protocol";

import type { MaybePromise, RoutedServerServiceAttachment } from "./types.ts";

/** An established, authorized ordered byte connection. */
export interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): MaybePromise<void>;
}

export interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

/** Context comes from the trusted listener, never from protocol messages. */
export type ByteConnectionAcceptor = (connection: ByteConnection, context?: Context) => ByteConnectionHandler;

export type ConnectionStage = "awaitingHello" | "handshaking" | "ready" | "closing" | "closed";

export interface ConnectionState {
	connection: ByteConnection;
	readonly context: Context;
	decoder: ClientMessageDecoder;
	serviceStateEncoders: Map<string, ServiceStateEncoder>;
	stage: ConnectionStage;
	disconnected: boolean;
	handshake?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
	serverServices?: RoutedServerServiceAttachment;
	activeRequests: Map<string, { controller: AbortController; target: RpcTarget }>;
}

export function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}
