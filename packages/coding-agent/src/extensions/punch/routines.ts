import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as chrono from "chrono-node";
import cronParser from "cron-parser";
import {
	DEFAULT_TIME_ZONE,
	formatInTimeZone,
	getTimeZoneOffsetMinutes,
	localDateParts,
	normalizeTimeZone,
	zonedWallTimeToUtc,
} from "./timezone.ts";

export type RoutineSchedule =
	| { kind: "once"; at: number }
	| { kind: "interval"; everyMs: number }
	| { kind: "cron"; cron: string };

export interface Routine {
	id: string;
	userId: string;
	channelId: string | null;
	type: "message" | "llm" | "heartbeat";
	payload: string;
	schedule: RoutineSchedule;
	timezone: string | null;
	enabled: boolean;
	state: "queued" | "running" | "succeeded" | "failed";
	attempts: number;
	nextRunAt: number;
	lastRunAt: number | null;
	createdAt: number;
	lastError: string | null;
}

interface RoutineExecution {
	id: string;
	routineId: string;
	userId: string;
	status: string;
	attempt: number;
	startedAt: number;
	finishedAt: number | null;
	error: string | null;
}

const DATA_DIR = process.env.PI_DATA_DIR || join(process.cwd(), ".pi");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const HISTORY_FILE = join(DATA_DIR, "routine-history.json");
const MAX_ATTEMPTS = Math.max(1, Number(process.env.PI_ROUTINE_MAX_ATTEMPTS) || 5);
const BASE_RETRY_MS = Math.max(1000, Number(process.env.PI_ROUTINE_RETRY_BASE_MS) || 30000);
const IDLE_POLL_MS = 60000;

let seq = 0;
let timer: NodeJS.Timeout | null = null;
let onFireCallback: ((routine: Routine) => Promise<void>) | null = null;
let runDuePending = false;
const hadRoutinesFile = existsSync(ROUTINES_FILE);
const hadHistoryFile = existsSync(HISTORY_FILE);
const routines: Routine[] = loadJsonArray<Routine>(ROUTINES_FILE)
	.map(normalizeRoutine)
	.filter((r): r is Routine => r !== null);
let history: RoutineExecution[] = loadJsonArray<RoutineExecution>(HISTORY_FILE);

function loadJsonArray<T>(file: string): T[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) throw new Error("expected JSON array");
		return parsed as T[];
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Failed to load ${file}: ${(err as Error).message}`);
	}
}

function atomicWrite(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

function saveRoutines(): void {
	atomicWrite(ROUTINES_FILE, routines);
}

function saveHistory(): void {
	atomicWrite(HISTORY_FILE, history);
}

function newId(): string {
	seq += 1;
	return (Date.now().toString(36) + seq.toString(36)).slice(-8);
}

function validTimezone(value: string | null): string | null {
	if (!value) return null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return value;
	} catch {
		return null;
	}
}

function normalizeRoutine(routine: Routine): Routine | null {
	if (
		!routine ||
		!routine.id ||
		!routine.userId ||
		!routine.type ||
		!routine.schedule ||
		!Number.isFinite(routine.nextRunAt)
	)
		return null;
	return {
		...routine,
		channelId: routine.channelId ?? null,
		enabled: routine.enabled !== false,
		createdAt: routine.createdAt ?? Date.now(),
		lastRunAt: Number.isFinite(routine.lastRunAt ?? NaN) ? routine.lastRunAt : null,
		attempts: Number.isInteger(routine.attempts) && routine.attempts >= 0 ? routine.attempts : 0,
		state: ["queued", "running", "succeeded", "failed"].includes(routine.state) ? routine.state : "queued",
		timezone: validTimezone(routine.timezone),
	};
}

const VALID_TYPES = new Set(["message", "llm", "heartbeat"]);

function parseShorthand(when: string): number | null {
	const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(when.trim());
	if (!match) return null;
	const n = Number(match[1]);
	const unit = match[2].toLowerCase();
	const ms = unit[0] === "m" ? 60000 : unit[0] === "h" ? 3600000 : 86400000;
	return Date.now() + n * ms;
}

function chronoReference(refDate: Date, timeZone: string | null): chrono.ParsingReference {
	if (!timeZone) return { instant: refDate };
	const normalized = normalizeTimeZone(timeZone);
	return { instant: refDate, timezone: getTimeZoneOffsetMinutes(normalized, refDate) };
}

function parseTime(when: string, refDate: Date = new Date(), timeZone: string | null = null): number {
	const trimmed = String(when).trim();
	const shorthand = parseShorthand(trimmed);
	if (shorthand !== null) return shorthand;
	const zone = timeZone ? normalizeTimeZone(timeZone) : null;
	if (!zone) {
		const parsed = chrono.parseDate(trimmed, refDate, { forwardDate: true });
		if (parsed) return parsed.getTime();
	} else {
		const parsed = chrono.parse(trimmed, chronoReference(refDate, zone), { forwardDate: true });
		const start = parsed[0]?.start;
		if (start) {
			if (start.isCertain("timezoneOffset")) return start.date().getTime();
			return zonedWallTimeToUtc(
				{
					year: start.get("year") ?? refDate.getFullYear(),
					month: start.get("month") ?? refDate.getMonth() + 1,
					day: start.get("day") ?? refDate.getDate(),
					hour: start.get("hour") ?? 0,
					minute: start.get("minute") ?? 0,
					second: start.get("second") ?? 0,
				},
				zone,
			);
		}
	}
	const fallback = Date.parse(trimmed);
	if (!Number.isNaN(fallback)) return fallback;
	throw new Error(`Could not parse time: "${when}"`);
}

function parseEveryInterval(intervalStr: string): RoutineSchedule {
	const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(intervalStr.trim());
	if (!match) throw new Error(`Unknown interval: "${intervalStr}"`);
	const n = Number(match[1]);
	if (n <= 0) throw new Error("Interval must be greater than zero");
	const unit = match[2].toLowerCase();
	const everyMs = unit[0] === "m" ? n * 60000 : n * 3600000;
	if (!Number.isFinite(everyMs)) throw new Error("Interval is too large");
	return { kind: "interval", everyMs };
}

function parseRecurrence(when: string, recurrence: string | null, timeZone: string | null = null): RoutineSchedule {
	const lower = String(recurrence || "once")
		.toLowerCase()
		.trim();
	const zone = timeZone ? normalizeTimeZone(timeZone) : null;
	if (lower === "once") return { kind: "once", at: parseTime(when, new Date(), zone) };
	if (lower === "daily" || lower === "weekly") {
		const at = parseTime(when, new Date(), zone);
		const parts = localDateParts(at, zone || DEFAULT_TIME_ZONE);
		return {
			kind: "cron",
			cron:
				lower === "daily"
					? `${parts.minute} ${parts.hour} * * *`
					: `${parts.minute} ${parts.hour} * * ${parts.weekday}`,
		};
	}
	const intervalMatch = /^every\s+(.+)$/i.exec(lower);
	if (intervalMatch) return parseEveryInterval(intervalMatch[1]);
	if (/^[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+$/.test(lower)) return { kind: "cron", cron: lower };
	throw new Error(`Unknown recurrence: "${recurrence}"`);
}

function localHour(at: number, timezone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(at);
	return Number(parts.find((p) => p.type === "hour")?.value) || 0;
}

interface ActiveHours {
	start: number;
	end: number;
	timezone: string;
}

function inActiveHours(activeHours: ActiveHours | null, at: number): boolean {
	if (!activeHours) return true;
	const hour = localHour(at, activeHours.timezone);
	if (activeHours.start === activeHours.end) return true;
	if (activeHours.start < activeHours.end) return hour >= activeHours.start && hour < activeHours.end;
	return hour >= activeHours.start || hour < activeHours.end;
}

function nextActiveTime(activeHours: ActiveHours | null, from: number): number {
	if (!activeHours || inActiveHours(activeHours, from)) return from;
	let candidate = from - (from % 60000) + 60000;
	const limit = candidate + 48 * 3600000;
	while (candidate <= limit) {
		if (inActiveHours(activeHours, candidate)) return candidate;
		candidate += 60000;
	}
	return candidate;
}

function computeNextRun(
	schedule: RoutineSchedule,
	afterMs: number = Date.now(),
	timezone: string | null = null,
	activeHours: ActiveHours | null = null,
): number | null {
	let next: number | null = null;
	if (schedule.kind === "once") {
		next = schedule.at > afterMs ? schedule.at : null;
	} else if (schedule.kind === "interval") {
		next = afterMs + schedule.everyMs;
	} else {
		try {
			const parser = cronParser.CronExpressionParser || cronParser;
			const expr = parser.parse(schedule.cron, {
				currentDate: new Date(afterMs),
				...(timezone ? { tz: timezone } : {}),
			});
			next = expr.next().getTime();
		} catch {
			throw new Error(`Invalid cron expression "${schedule.cron}"`);
		}
	}
	return next === null ? null : nextActiveTime(activeHours, next);
}

function addRoutine(input: {
	userId: string;
	channelId: string | null;
	type: string;
	payload: string;
	schedule: RoutineSchedule;
	timezone?: string | null;
}): Routine {
	if (!VALID_TYPES.has(input.type)) throw new Error("Invalid routine type");
	const normalizedTimezone =
		validTimezone(input.timezone ?? null) ?? (input.schedule.kind === "cron" ? DEFAULT_TIME_ZONE : null);
	const nextRunAt = computeNextRun(input.schedule, Date.now(), normalizedTimezone);
	if (nextRunAt === null) throw new Error("Scheduled time is in the past");
	const routine: Routine = {
		id: newId(),
		userId: String(input.userId),
		channelId: input.channelId ?? null,
		type: input.type as Routine["type"],
		payload: String(input.payload),
		schedule: input.schedule,
		timezone: normalizedTimezone,
		enabled: true,
		state: "queued",
		attempts: 0,
		nextRunAt,
		lastRunAt: null,
		createdAt: Date.now(),
		lastError: null,
	};
	routines.push(routine);
	saveRoutines();
	scheduleNext();
	return routine;
}

function removeRoutine(id: string, userId: string): boolean {
	const index = routines.findIndex((r) => r.id === id && r.userId === userId);
	if (index === -1) return false;
	routines.splice(index, 1);
	saveRoutines();
	scheduleNext();
	return true;
}

function setRoutineEnabled(id: string, userId: string, enabled: boolean): Routine | null {
	const routine = routines.find((r) => r.id === id && r.userId === userId);
	if (!routine) return null;
	routine.enabled = enabled;
	routine.state = enabled ? "queued" : routine.state;
	routine.lastError = null;
	if (enabled && routine.schedule.kind !== "once") {
		routine.nextRunAt = computeNextRun(routine.schedule, Date.now(), routine.timezone) ?? routine.nextRunAt;
	}
	saveRoutines();
	scheduleNext();
	return routine;
}

function pauseRoutine(id: string, userId: string): Routine | null {
	return setRoutineEnabled(id, userId, false);
}

function resumeRoutine(id: string, userId: string): Routine | null {
	return setRoutineEnabled(id, userId, true);
}

function listRoutines(userId: string): Routine[] {
	return routines.filter((r) => r.userId === userId);
}

function getRoutine(id: string): Routine | undefined {
	return routines.find((r) => r.id === id);
}

function listHistory(userId: string, routineId: string | null = null, limit = 20): RoutineExecution[] {
	return history
		.filter((h) => h.userId === userId && (!routineId || h.routineId === routineId))
		.slice(-Math.max(1, Math.min(100, limit)))
		.reverse();
}

function appendHistory(entry: RoutineExecution): void {
	history.push(entry);
	if (history.length > 2000) history = history.slice(-2000);
	saveHistory();
}

function markStarted(routine: Routine): RoutineExecution {
	routine.state = "running";
	routine.attempts += 1;
	routine.lastError = null;
	saveRoutines();
	return {
		id: newId(),
		routineId: routine.id,
		userId: routine.userId,
		status: "running",
		attempt: routine.attempts,
		startedAt: Date.now(),
		finishedAt: null,
		error: null,
	};
}

function completeRoutine(routine: Routine, execution: RoutineExecution): void {
	const finishedAt = Date.now();
	execution.status = "succeeded";
	execution.finishedAt = finishedAt;
	appendHistory(execution);
	const index = routines.findIndex((r) => r.id === routine.id);
	if (index === -1) return;
	if (routine.schedule.kind === "once") {
		routines.splice(index, 1);
	} else {
		routine.state = "succeeded";
		routine.lastRunAt = finishedAt;
		routine.attempts = 0;
		routine.nextRunAt = computeNextRun(routine.schedule, finishedAt, routine.timezone) ?? routine.nextRunAt;
		routine.state = "queued";
	}
	saveRoutines();
}

function failRoutine(routine: Routine, execution: RoutineExecution, error: unknown): void {
	const finishedAt = Date.now();
	const message = String(error instanceof Error ? error.message : error || "Routine failed").slice(0, 2000);
	execution.status = "failed";
	execution.finishedAt = finishedAt;
	execution.error = message;
	appendHistory(execution);
	routine.lastError = message;
	if (routine.attempts >= MAX_ATTEMPTS) {
		routine.state = "failed";
		routine.enabled = false;
	} else {
		routine.state = "queued";
		const retryMs = Math.min(3600000, BASE_RETRY_MS * 2 ** Math.max(0, routine.attempts - 1));
		routine.nextRunAt = nextActiveTime(null, finishedAt + retryMs);
	}
	saveRoutines();
}

function clearTimer(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

async function runDue(): Promise<void> {
	const now = Date.now();
	const due = routines.filter((r) => r.enabled && r.state === "queued" && r.nextRunAt <= now);
	for (const routine of due) {
		const execution = markStarted(routine);
		try {
			if (onFireCallback) await onFireCallback(routine);
			completeRoutine(routine, execution);
		} catch (err) {
			failRoutine(routine, execution, err);
		}
	}
	const upcoming = routines
		.filter((r) => r.enabled && r.state === "queued" && r.nextRunAt > now)
		.sort((a, b) => a.nextRunAt - b.nextRunAt);
	const delay = upcoming.length ? Math.min(2147483647, Math.max(0, upcoming[0].nextRunAt - Date.now())) : IDLE_POLL_MS;
	timer = setTimeout(() => {
		void scheduleNext();
	}, delay);
	timer.unref();
}

function scheduleNext(): void {
	clearTimer();
	if (runDuePending) return;
	runDuePending = true;
	void runDue()
		.catch((err) => {
			console.error("[punch] routines scheduler error:", err);
		})
		.finally(() => {
			runDuePending = false;
		});
}

function startScheduler(onFire: (routine: Routine) => Promise<void>): void {
	onFireCallback = onFire;
	scheduleNext();
}

function stopScheduler(): void {
	clearTimer();
	onFireCallback = null;
}

export {
	DEFAULT_TIME_ZONE,
	addRoutine,
	computeNextRun,
	formatInTimeZone,
	getRoutine,
	listHistory,
	listRoutines,
	parseRecurrence,
	parseTime,
	pauseRoutine,
	removeRoutine,
	resumeRoutine,
	startScheduler,
	stopScheduler,
};

for (const routine of routines) {
	if (routine.state === "running") {
		routine.state = "failed";
		routine.enabled = false;
		routine.lastError = "Interrupted by bot restart; paused to avoid duplicate execution.";
		history.push({
			id: newId(),
			routineId: routine.id,
			userId: routine.userId,
			status: "failed",
			attempt: routine.attempts || 1,
			startedAt: routine.lastRunAt ?? Date.now(),
			finishedAt: Date.now(),
			error: routine.lastError,
		});
	}
}
history = history.slice(-2000);
if (hadRoutinesFile) saveRoutines();
if (hadHistoryFile || history.length > 0) saveHistory();
