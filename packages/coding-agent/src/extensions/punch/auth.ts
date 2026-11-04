import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";

interface TokenRecord {
	userId: string;
	scope: string;
	expiresAt: number;
}

interface UserRecord {
	name: string;
	password: string;
	workspace?: string;
}

const DEFAULT_USER = "opencode";
const ttlSecs = Number(process.env.PI_OAUTH_TOKEN_TTL);
const TOKEN_TTL_MS = (Number.isFinite(ttlSecs) && ttlSecs > 0 ? ttlSecs : 3600) * 1000;

const tokens = new Map<string, TokenRecord>();

let cachedUsers: UserRecord[] | undefined;
let cachedUsersMtimeMs = -1;

function defaultUser(): string {
	return process.env.PI_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || DEFAULT_USER;
}

function usersFile(): string {
	return path.join(process.cwd(), ".pi", "users.json");
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function loadUsers(): UserRecord[] {
	const file = usersFile();
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {}
	if (cachedUsers && cachedUsersMtimeMs === mtimeMs) return cachedUsers;
	const users: UserRecord[] = [];
	const password = process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || "";
	if (password) {
		const name = defaultUser();
		if (name.includes(":")) throw new Error("PI_SERVER_USERNAME must not contain ':'");
		users.push({ name, password });
	}
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (entry && typeof entry === "object") {
					const user = entry as Partial<UserRecord>;
					if (
						typeof user.name === "string" &&
						user.name.length > 0 &&
						typeof user.password === "string" &&
						user.password.length > 0
					) {
						if (user.name.includes(":")) continue;
						const workspace =
							typeof user.workspace === "string" && path.isAbsolute(user.workspace) ? user.workspace : undefined;
						users.push({ name: user.name, password: user.password, workspace });
					}
				}
			}
		}
	} catch {}
	const seen = new Set<string>();
	for (const user of users) {
		const key = user.name.toLowerCase();
		if (seen.has(key)) throw new Error(`Duplicate punch user name (case-insensitive): ${user.name}`);
		seen.add(key);
	}
	cachedUsers = users;
	cachedUsersMtimeMs = mtimeMs;
	return users;
}

function isAuthConfigured(): boolean {
	return loadUsers().length > 0;
}

function getAuthHeader(): string | null {
	const user = loadUsers()[0];
	if (!user) return null;
	return `Basic ${Buffer.from(`${user.name}:${user.password}`).toString("base64")}`;
}

function isSandboxOwner(actor: string): boolean {
	const owner = loadUsers()[0];
	return owner !== undefined && owner.name.toLowerCase() === actor.toLowerCase();
}

function configuredUserName(name: string): string | null {
	const lowered = name.toLowerCase();
	return loadUsers().find((u) => u.name.toLowerCase() === lowered)?.name ?? null;
}

/** Directory a user may share through collabs: the sandbox owner gets the workspace root, other users only their `workspace` from users.json. */
function userWorkspaceRoot(actor: string): string | null {
	const users = loadUsers();
	const owner = users[0];
	if (owner && owner.name.toLowerCase() === actor.toLowerCase()) {
		return path.resolve(process.env.PI_WORKSPACE_ROOT || process.cwd());
	}
	const user = users.find((u) => u.name.toLowerCase() === actor.toLowerCase());
	return user?.workspace ? path.resolve(user.workspace) : null;
}

function verifyBasic(header: string | undefined): string | null {
	const match = /^Basic\s+(.+)$/i.exec(header ?? "");
	if (!match) return null;
	const [username, ...rest] = Buffer.from(match[1], "base64").toString("utf8").split(":");
	const password = rest.join(":");
	const users = loadUsers();
	const lowered = username.toLowerCase();
	const user = users.find(
		(u) =>
			u.name.toLowerCase() === lowered ||
			(lowered === DEFAULT_USER.toLowerCase() && u.name.toLowerCase() === defaultUser().toLowerCase()),
	);
	if (!user) return null;
	const provided = digest(password);
	const expected = digest(user.password);
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
	return user.name;
}

function pruneTokens(): void {
	const now = Date.now();
	for (const [token, record] of tokens) {
		if (record.expiresAt <= now) tokens.delete(token);
	}
}

function issueToken(userId: string, scope = "sandbox"): { token: string; expiresAt: number } {
	pruneTokens();
	const token = randomBytes(32).toString("base64url");
	const expiresAt = Date.now() + TOKEN_TTL_MS;
	tokens.set(token, { userId, scope, expiresAt });
	return { token, expiresAt };
}

function verifyToken(token: string): string | null {
	pruneTokens();
	const record = tokens.get(token);
	if (!record || record.expiresAt <= Date.now()) return null;
	return record.userId;
}

function authenticateBasic(req: IncomingMessage): string {
	const userId = verifyBasic(req.headers.authorization ?? "");
	if (!userId) throw new Error("Unauthorized");
	return userId;
}

function authenticate(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	const bearerMatch = /^Bearer\s+(.+)$/i.exec(header);
	if (bearerMatch) {
		const userId = verifyToken(bearerMatch[1].trim());
		if (userId) return userId;
		throw new Error("Unauthorized");
	}
	const userId = verifyBasic(header);
	if (!userId) throw new Error("Unauthorized");
	return userId;
}

export {
	authenticate,
	authenticateBasic,
	configuredUserName,
	getAuthHeader,
	isAuthConfigured,
	isSandboxOwner,
	issueToken,
	userWorkspaceRoot,
	verifyToken,
};
