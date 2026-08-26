import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { authenticate, authenticateBasic, isAuthConfigured, issueToken } from "./auth.ts";
import { create as createCollab, getFor, listFor, propose, review } from "./collabs.ts";
import { addRoutine, listRoutines, parseRecurrence, pauseRoutine, removeRoutine, resumeRoutine } from "./routines.ts";

const PORT = Number(process.env.PI_BOT_PORT) || 4098;
const HOST = process.env.PI_SERVER_HOST || "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		total += (chunk as Buffer).length;
		if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf8");
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		throw new Error("Invalid JSON body");
	}
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	const method = req.method ?? "GET";

	try {
		if (method === "POST" && path === "/oauth/token") {
			const body = await readJson(req);
			if (body.grant_type !== "client_credentials") {
				sendJson(res, 400, { error: "Unsupported grant_type" });
				return;
			}
			const actor = authenticateBasic(req);
			const issued = issueToken(actor);
			sendJson(res, 200, {
				access_token: issued.token,
				token_type: "Bearer",
				expires_in: Math.floor((issued.expiresAt - Date.now()) / 1000),
				scope: "sandbox",
			});
			return;
		}

		let actor: string;
		try {
			actor = authenticate(req);
		} catch (err) {
			sendJson(res, 401, { error: (err as Error).message });
			return;
		}

		if (method === "GET" && path === "/collabs") {
			sendJson(res, 200, { collabs: listFor(actor) });
			return;
		}
		if (method === "POST" && path === "/collabs/create") {
			const body = await readJson(req);
			const reviewer = String(body.reviewer ?? "");
			const workspace = String(body.workspace ?? "");
			sendJson(res, 200, { collab: createCollab({ owner: actor, reviewer, workspace }) });
			return;
		}
		const collabMatch = /^\/collabs\/(col_[a-f0-9]{12})(?:\/(propose|review))?$/.exec(path);
		if (collabMatch) {
			const id = collabMatch[1];
			const sub = collabMatch[2];
			if (method === "GET" && !sub) {
				sendJson(res, 200, { collab: getFor(id, actor) });
				return;
			}
			if (method === "POST" && sub === "propose") {
				const body = await readJson(req);
				sendJson(res, 200, { collab: propose({ id, actor, head: String(body.head ?? "") }) });
				return;
			}
			if (method === "POST" && sub === "review") {
				const body = await readJson(req);
				sendJson(res, 200, {
					collab: review({ id, actor, approve: body.approve === true, notes: String(body.notes ?? "") }),
				});
				return;
			}
		}

		if (method === "GET" && path === "/routines/list") {
			sendJson(res, 200, { routines: listRoutines(actor) });
			return;
		}
		if (method === "POST" && path === "/routines/create") {
			const body = await readJson(req);
			const userId = actor;
			const when = String(body.when ?? "");
			const recurrence = String(body.recurrence ?? "once");
			const timezone = body.timezone ? String(body.timezone) : null;
			const type = String(body.type ?? "message");
			const schedule = parseRecurrence(when, recurrence, timezone);
			const routine = addRoutine({
				userId,
				channelId: body.channelId ? String(body.channelId) : null,
				type,
				payload: String(body.payload ?? ""),
				schedule,
				timezone,
			});
			sendJson(res, 200, { routine });
			return;
		}
		const routineMatch = /^\/routines\/([^/]+)(?:\/(pause|resume))?$/.exec(path);
		if (routineMatch) {
			const id = routineMatch[1];
			const sub = routineMatch[2];
			const userId = actor;
			if (method === "DELETE" && !sub) {
				removeRoutine(id, userId);
				sendJson(res, 200, { ok: true });
				return;
			}
			if (method === "POST" && sub === "pause") {
				sendJson(res, 200, { routine: pauseRoutine(id, userId) });
				return;
			}
			if (method === "POST" && sub === "resume") {
				sendJson(res, 200, { routine: resumeRoutine(id, userId) });
				return;
			}
		}

		sendJson(res, 404, { error: "Not found" });
	} catch (err) {
		sendJson(res, 500, { error: (err as Error).message });
	}
}

let started = false;

export function startPunchServer(): void {
	if (started) return;
	if (!isAuthConfigured()) return;
	started = true;
	const server = createServer((req, res) => {
		void handle(req, res);
	});
	server.on("error", (err) => {
		console.error(`punch server on port ${PORT} failed: ${(err as Error).message}`);
	});
	server.listen(PORT, HOST);
}
