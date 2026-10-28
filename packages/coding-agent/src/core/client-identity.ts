import { type ClientIdentity, PI_ATTRIBUTION } from "@punch-bot/ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * How pi's requests identify it to providers: the short `punch-agent` `User-Agent`, without host details, and
 * attribution to pi as a CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "short",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? PI_ATTRIBUTION : null,
	};
}
