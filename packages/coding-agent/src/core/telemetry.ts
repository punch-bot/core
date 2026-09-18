import { get as httpsGet } from "node:https";
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

	const request = httpsGet(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, (response) => {
		response.on("error", () => {});
		response.resume();
	});
	request.once("socket", (socket) => socket.unref());
	request.once("error", () => {});
	const timeout = setTimeout(() => request.destroy(), 5000);
	timeout.unref();
	request.once("close", () => clearTimeout(timeout));
}
