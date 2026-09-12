import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface A2aPeerRecord {
	id: string;
	name: string;
	url: string;
	pid: number;
	cwd?: string;
	startedAt: number;
	updatedAt: number;
}

export interface LocalA2aDiscoveryOptions {
	dir: string;
	ttlMs?: number;
	now?: () => number;
	isAlive?: (pid: number) => boolean;
}

const DEFAULT_TTL_MS = 45_000;

export function defaultA2aDiscoveryDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PUNCH_A2A_DISCOVERY_DIR;
	if (configured?.trim()) return path.resolve(configured);
	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (runtimeDir?.trim()) return path.join(runtimeDir, "punch", "a2a");
	return path.join(tmpdir(), `punch-a2a-${currentUid()}`);
}

function currentUid(): string | number {
	if (typeof process.getuid === "function") return process.getuid();
	return "user";
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function parseRecord(raw: unknown): A2aPeerRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	if (typeof value.name !== "string" || value.name.trim().length === 0) return undefined;
	if (typeof value.url !== "string" || !isHttpUrl(value.url)) return undefined;
	if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
	if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return undefined;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined;
	return {
		id: value.id,
		name: value.name.trim(),
		url: value.url,
		pid: value.pid,
		...(cwd ? { cwd } : {}),
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
	};
}

function atomicWrite(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

function unlinkQuiet(file: string): void {
	try {
		unlinkSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

export class LocalA2aDiscovery {
	readonly dir: string;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly isAlive: (pid: number) => boolean;
	private record: A2aPeerRecord | undefined;
	private filePath: string | undefined;

	constructor(options: LocalA2aDiscoveryOptions) {
		this.dir = path.resolve(options.dir);
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.now = options.now ?? Date.now;
		this.isAlive = options.isAlive ?? pidAlive;
	}

	advertise(input: Omit<A2aPeerRecord, "updatedAt">): A2aPeerRecord {
		const record: A2aPeerRecord = { ...input, name: input.name.trim(), updatedAt: this.now() };
		if (!record.name) throw new Error("A2A peer name is required.");
		if (!isHttpUrl(record.url)) throw new Error("A2A peer URL must be absolute http(s).");
		this.record = record;
		this.filePath = path.join(this.dir, `${record.id}.json`);
		atomicWrite(this.filePath, record);
		return record;
	}

	heartbeat(): A2aPeerRecord | undefined {
		if (!this.record || !this.filePath) return undefined;
		this.record = { ...this.record, updatedAt: this.now() };
		atomicWrite(this.filePath, this.record);
		return this.record;
	}

	list(options?: { excludeId?: string; excludePid?: number }): A2aPeerRecord[] {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		let entries: string[];
		try {
			entries = readdirSync(this.dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const now = this.now();
		const excludeId = options?.excludeId ?? this.record?.id;
		const excludePid = options?.excludePid;
		const peers: A2aPeerRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const file = path.join(this.dir, entry);
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				continue;
			}
			const record = parseRecord(parsed);
			if (!record) continue;
			if (excludeId && record.id === excludeId) continue;
			if (excludePid !== undefined && record.pid === excludePid) continue;
			const stale = now - record.updatedAt > this.ttlMs;
			const dead = !this.isAlive(record.pid);
			if (stale || dead) {
				try {
					unlinkQuiet(file);
				} catch {}
				continue;
			}
			peers.push(record);
		}
		return peers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	find(name: string, options?: { excludeId?: string; excludePid?: number }): A2aPeerRecord | undefined {
		const lowered = name.trim().toLowerCase();
		if (!lowered) return undefined;
		const matches = this.list(options).filter((peer) => peer.name.toLowerCase() === lowered);
		if (matches.length === 0) return undefined;
		return matches.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	}

	close(): void {
		if (this.filePath) unlinkQuiet(this.filePath);
		this.filePath = undefined;
		this.record = undefined;
	}
}
