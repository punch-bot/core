import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { BACKGROUND_CONTEXT } from "@punch-bot/agent";
import { DEFAULT_MAX_FRAME_LENGTH } from "@punch-bot/protocol";
import WebSocket, { WebSocketServer } from "ws";
import type { ByteConnection, ByteConnectionAcceptor } from "./connection.ts";
import type { ServerListener } from "./listener.ts";
import { type Principal, withPrincipal } from "./principal.ts";

export interface WebSocketIdentity {
	readonly principal: Principal;
	/** Access-token expiry, in milliseconds since the epoch. */
	readonly expiresAt: number;
}

export interface WebSocketListenerOptions {
	/** The caller owns HTTP/TLS listening and shutdown. */
	readonly server: HttpServer;
	readonly path?: string;
	/** Verify credentials, issuer, audience and scopes before returning an identity. */
	authenticate(request: IncomingMessage, signal: AbortSignal): Promise<WebSocketIdentity>;
	/** Browser origins are denied unless explicitly listed. Native clients may omit Origin. */
	readonly origins?: readonly string[];
	readonly maxFrameLength?: number;
	readonly maxPendingBytes?: number;
	readonly maxConnections?: number;
	readonly authenticationTimeoutMs?: number;
}

/** Authenticated binary WebSockets carrying the existing framed protocol unchanged. */
export function createWebSocketListener(options: WebSocketListenerOptions): ServerListener {
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	const maxPendingBytes = options.maxPendingBytes ?? (maxFrameLength + 4) * 4;
	const maxConnections = options.maxConnections ?? 256;
	const timeoutMs = options.authenticationTimeoutMs ?? 10_000;
	for (const value of [maxFrameLength, maxPendingBytes, maxConnections, timeoutMs]) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("WebSocket limits must be positive integers");
	}
	if (maxFrameLength > 0xffff_ffff || maxPendingBytes < maxFrameLength + 4 || timeoutMs > 2_147_483_647) {
		throw new TypeError("Invalid WebSocket limits");
	}
	const path = options.path ?? "/punch";
	const sockets = new Set<Duplex>();
	const controllers = new Set<AbortController>();
	let wss: WebSocketServer | undefined;
	let accept: ByteConnectionAcceptor | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		socket.on("error", () => socket.destroy());
		const reject = (status: number): void => {
			socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		};
		if (request.url?.split("?", 1)[0] !== path) {
			reject(404);
			return;
		}
		if (closed || sockets.size >= maxConnections) {
			reject(503);
			return;
		}
		if (request.headers.origin && !options.origins?.includes(request.headers.origin)) {
			reject(403);
			return;
		}
		const controller = new AbortController();
		controllers.add(controller);
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
			controllers.delete(controller);
			controller.abort();
		});
		const timer = setTimeout(() => {
			controller.abort();
			controllers.delete(controller);
			socket.destroy();
		}, timeoutMs);
		timer.unref();
		void Promise.resolve()
			.then(() => options.authenticate(request, controller.signal))
			.then((identity) => {
				if (closed || socket.destroyed || controller.signal.aborted || !wss || !accept) return;
				const lifetime = identity.expiresAt - Date.now();
				if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 2_147_483_647) return reject(401);
				const context = withPrincipal(identity.principal, BACKGROUND_CONTEXT);
				const acceptConnection = accept;
				wss.handleUpgrade(request, socket, head, (ws) => {
					const connection = new WebSocketConnection(ws, maxPendingBytes);
					const handler = acceptConnection(connection, context);
					let terminal = false;
					const expire = setTimeout(() => ws.terminate(), lifetime);
					expire.unref();
					ws.on("message", (data, binary) => {
						if (!binary) return ws.close(1003, "Binary protocol required");
						handler.onData(
							data instanceof Buffer ? data : Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data),
						);
					});
					ws.on("error", (error) => {
						if (!terminal) {
							terminal = true;
							handler.onError(error);
						}
						ws.terminate();
					});
					ws.once("close", () => {
						clearTimeout(expire);
						if (!terminal) {
							terminal = true;
							handler.onClose();
						}
					});
				});
			})
			.catch(() => {
				if (!socket.destroyed) reject(401);
			})
			.finally(() => {
				clearTimeout(timer);
				controllers.delete(controller);
			});
	};
	return {
		async start(acceptor) {
			if (wss || closed) throw new Error("WebSocket listener already started or closed");
			accept = acceptor;
			wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameLength + 4, perMessageDeflate: false });
			options.server.on("upgrade", upgrade);
		},
		async close() {
			if (closePromise) return closePromise;
			closed = true;
			options.server.off("upgrade", upgrade);
			for (const controller of controllers) controller.abort();
			for (const socket of sockets) socket.destroy();
			closePromise = wss ? new Promise<void>((resolve) => wss!.close(() => resolve())) : Promise.resolve();
			return closePromise;
		},
	};
}

class WebSocketConnection implements ByteConnection {
	readonly #socket: WebSocket;
	readonly #maxPendingBytes: number;
	#pendingBytes = 0;
	#closing = false;
	#closePromise?: Promise<void>;
	constructor(socket: WebSocket, maxPendingBytes: number) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
	}
	get closed(): boolean {
		return this.#closing || this.#socket.readyState !== WebSocket.OPEN;
	}
	send(chunk: Uint8Array): Promise<void> {
		if (this.closed) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket pending byte limit exceeded"));
		}
		this.#pendingBytes += chunk.byteLength;
		return new Promise<void>((resolve, reject) => {
			this.#socket.send(chunk.slice(), { binary: true }, (error) => {
				this.#pendingBytes -= chunk.byteLength;
				if (error) reject(error);
				else resolve();
			});
		});
	}
	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve();
		const final = finalChunk ? this.send(finalChunk) : Promise.resolve();
		this.#closing = true;
		this.#closePromise = new Promise<void>((resolve) => {
			const timer = setTimeout(() => this.#socket.terminate(), 5_000);
			timer.unref();
			this.#socket.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			void final.then(
				() => this.#socket.close(),
				() => this.#socket.terminate(),
			);
		});
		return this.#closePromise;
	}
}
