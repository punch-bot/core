import * as undici from "undici";
import { getChangelogPath } from "../config.ts";
import { getNewEntries, parseChangelog } from "../utils/changelog.ts";
import type { SettingsManager } from "./settings-manager.ts";

const TELEMETRY_TIMEOUT_MS = 5000;

/**
 * Send the one-time install ping without keeping the process alive.
 *
 * Uses the same env-proxy agent Pi installs for its managed HTTP clients, so a
 * configured `httpProxy` is honored. The dispatcher is dedicated to this request
 * and destroyed once the ping settles, which bounds teardown instead of leaving
 * a connecting socket behind on one-shot commands.
 */
function sendInstallPing(url: string): void {
	let dispatcher: undici.EnvHttpProxyAgent;
	try {
		dispatcher = new undici.EnvHttpProxyAgent({
			allowH2: false,
			proxyTunnel: true,
			connect: { timeout: TELEMETRY_TIMEOUT_MS },
			headersTimeout: TELEMETRY_TIMEOUT_MS,
			bodyTimeout: TELEMETRY_TIMEOUT_MS,
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
