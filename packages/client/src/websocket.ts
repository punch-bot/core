import { DEFAULT_MAX_FRAME_LENGTH } from "@punch-bot/protocol";
import WebSocket from "ws";
import type { ByteTransportFactory } from "./transport.ts";

export interface WebSocketTransportOptions {
	readonly url: string;
	/** Called for every connection attempt. Return a fresh short-lived access token. */
	getAccessToken(): Promise<string>;
	readonly maxFrameLength?: number;
	readonly maxPendingBytes?: number;
	readonly handshakeTimeoutMs?: number;
}

/** Node WebSocket transport. Reconnection never replays application requests. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	const url = new URL(options.url);
	if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
		throw new TypeError("Expected a ws/wss URL without credentials or fragment");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	const maxPendingBytes = options.maxPendingBytes ?? (maxFrameLength + 4) * 4;
	const handshakeTimeout = options.handshakeTimeoutMs ?? 10_000;
	if (
		!Number.isSafeInteger(maxFrameLength) ||
		maxFrameLength <= 0 ||
		maxFrameLength > 0xffff_ffff ||
		!Number.isSafeInteger(maxPendingBytes) ||
		maxPendingBytes < maxFrameLength + 4 ||
		!Number.isSafeInteger(handshakeTimeout) ||
		handshakeTimeout <= 0 ||
		handshakeTimeout > 2_147_483_647
	) {
		throw new TypeError("Invalid WebSocket transport limits");
	}
	return async (handlers) => {
		const token = await options.getAccessToken();
		if (!token || /[\r\n]/.test(token)) throw new Error("Invalid WebSocket access token");
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url, {
				headers: { Authorization: `Bearer ${token}` },
				maxPayload: maxFrameLength + 4,
				perMessageDeflate: false,
				handshakeTimeout,
				followRedirects: false,
			});
			let opened = false;
			let terminal = false;
			let pendingBytes = 0;
			const fail = (error: Error): void => {
				if (terminal) return;
				terminal = true;
				if (opened) handlers.onError(error);
				else reject(error);
				socket.terminate();
			};
			socket.on("error", fail);
			socket.once("close", () => {
				if (terminal) return;
				terminal = true;
				if (opened) handlers.onClose();
				else reject(new Error("WebSocket closed before connecting"));
			});
			socket.on("message", (data, binary) => {
				if (terminal) return;
				if (!binary) return fail(new Error("Expected binary WebSocket data"));
				handlers.onData(
					data instanceof Buffer ? data : Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data),
				);
			});
			socket.once("open", () => {
				opened = true;
				resolve({
					send(chunk) {
						if (terminal || socket.readyState !== WebSocket.OPEN)
							return Promise.reject(new Error("WebSocket is closed"));
						if (pendingBytes + chunk.byteLength > maxPendingBytes)
							return Promise.reject(new Error("WebSocket pending byte limit exceeded"));
						pendingBytes += chunk.byteLength;
						return new Promise<void>((done, failed) => {
							socket.send(chunk.slice(), { binary: true }, (error) => {
								pendingBytes -= chunk.byteLength;
								if (error) failed(error);
								else done();
							});
						});
					},
					close() {
						socket.terminate();
					},
				});
			});
		});
	};
}
