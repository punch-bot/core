import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface CollabProposal {
	branch: string;
	author: string;
	reviewer: string;
	head: string;
	authorApprovedAt: number | null;
	reviewerApprovedAt: number | null;
	reviewedHead: string | null;
	reviewNotes: string;
	status: "pending_review" | "approved" | "changes_requested" | "merged";
	mergedAt?: number;
}

export interface Collab {
	id: string;
	owner: string;
	participants: string[];
	repo: string;
	baseRef: string;
	base: string;
	workspaces: Record<string, string>;
	proposal: CollabProposal | null;
	createdAt: number;
	updatedAt: number;
}

const ID_PATTERN = /^col_[a-f0-9]{12}$/;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;

let records: Collab[] = [];

export function collabStateFile(): string {
	return path.join(process.cwd(), ".pi", "collabs.json");
}

function load(): void {
	let raw: string;
	try {
		raw = readFileSync(collabStateFile(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			records = [];
			return;
		}
		throw err;
	}
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("collabs.json must contain an array");
	records = parsed;
}

function reload(): void {
	load();
}

function save(): void {
	const file = collabStateFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

function collabOrThrow(id: string): Collab {
	if (!ID_PATTERN.test(id)) throw new Error("Invalid collaboration ID.");
	const collab = records.find((c) => c.id === id);
	if (!collab) throw new Error("Collaboration not found.");
	return collab;
}

function requireParticipant(collab: Collab, actor: string): void {
	if (!collab.participants.includes(actor)) throw new Error("Sandbox is not a collaboration participant.");
}

function write(collab: Collab): void {
	reload();
	const index = records.findIndex((c) => c.id === collab.id);
	if (index === -1) throw new Error("Collaboration not found.");
	records[index] = collab;
	save();
}

function workspaceRoot(): string {
	return process.env.PI_WORKSPACE_ROOT || process.cwd();
}

function safeWorkspace(p: unknown): string {
	if (typeof p !== "string") throw new Error("Workspace must be an absolute path under the workspace root.");
	if (p.includes("\0")) throw new Error("Workspace must be an absolute path under the workspace root.");
	if (!path.isAbsolute(p)) throw new Error("Workspace must be an absolute path under the workspace root.");
	const resolved = path.resolve(p).replace(/\/+$/, "");
	const root = path.resolve(workspaceRoot()).replace(/\/+$/, "");
	if (!resolved.startsWith(root + path.sep) || resolved === root) {
		throw new Error("Workspace must be an absolute path under the workspace root.");
	}
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		return resolved;
	}
	let existing = resolved;
	while (true) {
		let realExisting: string | null = null;
		try {
			realExisting = realpathSync(existing);
		} catch {}
		if (realExisting !== null) {
			if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
				throw new Error("Workspace must be an absolute path under the workspace root.");
			}
			const suffix = resolved.slice(existing.length);
			const fullReal = `${realExisting}${suffix}`;
			if (!fullReal.startsWith(realRoot + path.sep)) {
				throw new Error("Workspace must be an absolute path under the workspace root.");
			}
			return resolved;
		}
		const parent = path.dirname(existing);
		if (parent === existing) {
			return resolved;
		}
		existing = parent;
	}
}

function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { encoding: "utf8", cwd }).trim();
}

function bareHead(collab: Collab, branch: string): string {
	return git(["--git-dir", collab.repo, "rev-parse", `refs/heads/${branch}`]).toLowerCase();
}

export function collabDir(): string {
	const configured = process.env.PI_COLLAB_DIR;
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".pi", "collab");
}

export function listFor(actor: string): Collab[] {
	reload();
	return records.filter((c) => c.participants.includes(actor));
}

export function getFor(id: string, actor: string): Collab {
	reload();
	const collab = collabOrThrow(id);
	requireParticipant(collab, actor);
	return collab;
}

export function create(opts: { owner: string; reviewer: string; workspace: string }): Collab {
	if (!opts.reviewer || opts.reviewer === opts.owner) throw new Error("reviewer must be a different sandbox");
	const source = safeWorkspace(opts.workspace);
	const id = `col_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const repo = path.join(collabDir(), `${id}.git`);
	const clonePath = path.join(collabDir(), id);
	if (!existsSync(path.join(source, ".git"))) {
		git(["init", "--initial-branch=main", source]);
	}
	let hasHead = true;
	try {
		git(["rev-parse", "--verify", "HEAD"], source);
	} catch {
		hasHead = false;
	}
	if (!hasHead) {
		git(["config", "user.name", `Punch ${opts.owner}`], source);
		git(["config", "user.email", `${opts.owner}@punch.local`], source);
		git(["add", "--all"], source);
		git(["commit", "--allow-empty", "--message", "Initialize collaboration"], source);
	}
	mkdirSync(path.dirname(repo), { recursive: true });
	git(["clone", "--bare", source, repo]);
	const base = git(["--git-dir", repo, "rev-parse", "HEAD"]).toLowerCase();
	git(["--git-dir", repo, "update-ref", "refs/heads/main", base]);
	git(["--git-dir", repo, "symbolic-ref", "HEAD", "refs/heads/main"]);
	try {
		git(["remote", "remove", "punch-collab"], source);
	} catch {}
	git(["remote", "add", "punch-collab", repo], source);
	mkdirSync(clonePath, { recursive: true });
	git(["clone", repo, clonePath]);
	const collab: Collab = {
		id,
		owner: opts.owner,
		participants: [opts.owner, opts.reviewer],
		repo,
		baseRef: "main",
		base,
		workspaces: { [opts.owner]: source, [opts.reviewer]: clonePath },
		proposal: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	reload();
	records.push(collab);
	save();
	return collab;
}

export function propose(opts: { id: string; actor: string; head: string }): Collab {
	reload();
	if (!SHA_PATTERN.test(opts.head)) throw new Error("Invalid proposal SHA.");
	const collab = collabOrThrow(opts.id);
	requireParticipant(collab, opts.actor);
	const branch = `changes/${opts.id}`;
	const remoteHead = bareHead(collab, branch);
	if (remoteHead !== opts.head.toLowerCase())
		throw new Error("Proposal SHA is not current collaboration branch head.");
	try {
		git(["--git-dir", collab.repo, "merge-base", "--is-ancestor", collab.base, remoteHead]);
	} catch {
		throw new Error("Proposal does not descend from canonical main.");
	}
	const reviewer = collab.participants.find((p) => p !== opts.actor);
	if (!reviewer) throw new Error("No reviewer participant.");
	const previous = collab.proposal;
	if (previous?.status === "changes_requested") {
		const rejectedHead = previous.reviewedHead ?? previous.head;
		if (rejectedHead === remoteHead) {
			throw new Error("Proposal unchanged since changes were requested; push new commits before reproposing.");
		}
	}
	collab.proposal = {
		branch,
		author: opts.actor,
		reviewer,
		head: remoteHead,
		authorApprovedAt: Date.now(),
		reviewerApprovedAt: null,
		reviewedHead: null,
		reviewNotes: "",
		status: "pending_review",
	};
	collab.updatedAt = Date.now();
	write(collab);
	return collab;
}

export function review(opts: { id: string; actor: string; approve: boolean; notes?: string }): Collab {
	reload();
	const collab = collabOrThrow(opts.id);
	requireParticipant(collab, opts.actor);
	const proposal = collab.proposal;
	if (!proposal || proposal.status === "merged") throw new Error("No proposal awaiting review.");
	if (proposal.status === "changes_requested") {
		throw new Error("Proposal has changes requested; author must propose a new SHA before review.");
	}
	if (proposal.reviewer !== opts.actor) throw new Error("Only other participant may review this proposal.");
	const remoteHead = bareHead(collab, proposal.branch);
	if (remoteHead !== proposal.head) throw new Error("Branch changed. Author must propose new SHA again.");
	proposal.reviewNotes = String(opts.notes || "").slice(0, 4000);
	proposal.reviewedHead = remoteHead;
	proposal.reviewerApprovedAt = opts.approve ? Date.now() : null;
	proposal.status = opts.approve ? "approved" : "changes_requested";
	collab.updatedAt = Date.now();
	write(collab);
	if (opts.approve) {
		const merged = mergeIfApproved(collab);
		if (merged) return collabOrThrow(collab.id);
	}
	return collab;
}

function mergeIfApproved(collab: Collab): boolean {
	const proposal = collab.proposal;
	if (!proposal) return false;
	if (!proposal.authorApprovedAt || !proposal.reviewerApprovedAt) return false;
	if (proposal.reviewedHead !== proposal.head) return false;
	const remoteHead = bareHead(collab, proposal.branch);
	if (remoteHead !== proposal.head) return false;
	try {
		git(["--git-dir", collab.repo, "merge-base", "--is-ancestor", collab.base, remoteHead]);
	} catch {
		throw new Error("Cannot auto-merge: canonical main and proposal diverged.");
	}
	git(["--git-dir", collab.repo, "update-ref", "refs/heads/main", remoteHead, collab.base]);
	collab.base = remoteHead;
	proposal.status = "merged";
	proposal.mergedAt = Date.now();
	collab.updatedAt = Date.now();
	write(collab);
	return true;
}

load();
