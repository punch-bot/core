import { getChangelogPath } from "../config.ts";
import { getNewEntries, parseChangelog } from "../utils/changelog.ts";
import type { SettingsManager } from "./settings-manager.ts";

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

	void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
		signal: AbortSignal.timeout(5000),
	})
		.then(() => undefined)
		.catch(() => undefined);
}
