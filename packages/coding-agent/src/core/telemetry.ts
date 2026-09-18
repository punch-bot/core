import * as undici from "undici";
import { getChangelogPath } from "../config.ts";
import { getNewEntries, parseChangelog } from "../utils/changelog.ts";
import { createHttpDispatcher } from "./http-dispatcher.ts";
import type { SettingsManager } from "./settings-manager.ts";

const TELEMETRY_TIMEOUT_MS = 5000;

/**
 * Send the one-time install ping without keeping the process alive.
 *
 * Reuses Pi's env-proxy dispatcher setup, so a configured `httpProxy` is honored
 * and undici client errors cannot crash the CLI. The dispatcher is dedicated to
 * this request and destroyed once the ping settles, which bounds teardown
 * instead of leaving a connecting socket behind on one-shot commands.
 */
function sendInstallPing(url: string): void {
	let dispatcher: undici.Dispatcher;
	try {
		dispatcher = createHttpDispatcher({
			timeoutMs: TELEMETRY_TIMEOUT_MS,
			connectTimeoutMs: TELEMETRY_TIMEOUT_MS,
		});
	} catch {
		return;
	}

	void undici
		.request(url, { dispatcher, signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS) })
		.then((response) => response.body.dump())
		.catch(() => {})
		.finally(() => dispatcher.destroy());
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

/** Record the current version and send the one-time install/update ping when the changelog advanced. */
export function recordInstallTelemetry(settingsManager: SettingsManager, version: string): void {
	const lastVersion = settingsManager.getLastChangelogVersion();
	if (lastVersion) {
		const entries = parseChangelog(getChangelogPath());
		if (getNewEntries(entries, lastVersion).length === 0) return;
	}

	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return;
	settingsManager.setLastChangelogVersion(version);
	if (!isInstallTelemetryEnabled(settingsManager)) return;

	sendInstallPing(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`);
}
