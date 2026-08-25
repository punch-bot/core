export const DEFAULT_TIME_ZONE = "UTC";

export function normalizeTimeZone(value: string | null | undefined): string {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return DEFAULT_TIME_ZONE;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format();
		return trimmed;
	} catch {
		throw new Error("Timezone must be a valid IANA timezone, such as `America/New_York`.");
	}
}

export function getTimeZoneOffsetMinutes(timeZone: string, date: Date = new Date()): number {
	const zone = normalizeTimeZone(timeZone);
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = Object.fromEntries(
		formatter
			.formatToParts(date)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
	return Math.round((asUtc - date.getTime()) / 60_000);
}

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localDateParts(
	timestamp: number,
	timeZone: string = DEFAULT_TIME_ZONE,
): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: number;
} {
	const zone = normalizeTimeZone(timeZone);
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		weekday: "short",
		hour12: false,
	});
	const parts = Object.fromEntries(
		formatter
			.formatToParts(new Date(timestamp))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekday: WEEKDAY_MAP[String(parts.weekday)] ?? 0,
	};
}

interface WallTime {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
	second?: number;
}

function wallFieldsMatch(
	parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
	time: WallTime,
): boolean {
	return (
		parts.year === time.year &&
		parts.month === time.month &&
		parts.day === time.day &&
		parts.hour === (time.hour ?? 0) &&
		parts.minute === (time.minute ?? 0) &&
		parts.second === (time.second ?? 0)
	);
}

export function zonedWallTimeToUtc(time: WallTime, timeZone: string = DEFAULT_TIME_ZONE): number {
	const zone = normalizeTimeZone(timeZone);
	const year = time.year;
	const month = time.month;
	const day = time.day;
	const hour = time.hour ?? 0;
	const minute = time.minute ?? 0;
	const second = time.second ?? 0;
	const desired = Date.UTC(year, month - 1, day, hour, minute, second);
	const offsets = new Set<number>();
	for (let h = -15; h <= 15; h++) {
		offsets.add(getTimeZoneOffsetMinutes(zone, new Date(desired + h * 3_600_000)));
	}
	const matching: number[] = [];
	for (const offsetMinutes of offsets) {
		const candidate = desired - offsetMinutes * 60_000;
		if (wallFieldsMatch(localDateParts(candidate, zone), { year, month, day, hour, minute, second })) {
			matching.push(candidate);
		}
	}
	if (matching.length === 0) {
		const pad = (n: number) => String(n).padStart(2, "0");
		throw new Error(
			`Local time ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)} does not exist in ${zone}`,
		);
	}
	return Math.min(...matching);
}

export function formatInTimeZone(timestamp: number, timeZone: string): string | null {
	if (!Number.isFinite(timestamp)) return null;
	const zone = normalizeTimeZone(timeZone);
	const formatted = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
	return `${formatted} (${zone})`;
}
