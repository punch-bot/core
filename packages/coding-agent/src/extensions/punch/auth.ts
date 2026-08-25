import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
}

const DEFAULT_USER = "opencode";
const TOKEN_TTL_MS = (Number(process.env.PI_OAUTH_TOKEN_TTL) || 3600) * 1000;

const tokens = new Map<string, TokenRecord>();

function defaultUser(): string {
	return process.env.PI_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || DEFAULT_USER;
}

function usersFile(): string {
	return path.join(process.cwd(), ".pi", "users.json");
}

function loadUsers(): UserRecord[] {
	const users: UserRecord[] = [];
	const password = process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || "";
	if (password) users.push({ name: defaultUser(), password });
	try {
		const parsed = JSON.parse(readFileSync(usersFile(), "utf8")) as unknown;
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (entry && typeof entry === "object") {
					const user = entry as Partial<UserRecord>;
					if (typeof user.name === "string" && typeof user.password === "string")
						users.push({ name: user.name, password: user.password });
				}
			}
		}
	} catch {}
	return users;
}

function verifyBasic(header: string | undefined): string | null {
	const match = /^Basic\s+(.+)$/i.exec(header ?? "");
	if (!match) return null;
	const [username, ...rest] = Buffer.from(match[1], "base64").toString("utf8").split(":");
	const password = rest.join(":");
	const users = loadUsers();
	const user = users.find((u) => u.name === username || (username === DEFAULT_USER && u.name === defaultUser()));
	if (!user || user.password !== password) return null;
	return user.name;
}

function issueToken(userId: string, scope = "sandbox"): { token: string; expiresAt: number } {
	const token = randomBytes(32).toString("base64url");
	const expiresAt = Date.now() + TOKEN_TTL_MS;
	tokens.set(token, { userId, scope, expiresAt });
	return { token, expiresAt };
}

function verifyToken(token: string): string | null {
	const record = tokens.get(token);
	if (!record || record.expiresAt <= Date.now()) return null;
	return record.userId;
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

export { authenticate, issueToken, verifyToken };
