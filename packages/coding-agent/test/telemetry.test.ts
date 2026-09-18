import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { recordInstallTelemetry } from "../src/core/telemetry.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("install telemetry", () => {
	it("does not advance the version marker while offline", () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("advances the marker without sending when telemetry is disabled", () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends only the version payload", () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const fetchMock = vi.fn().mockResolvedValue(new Response());
		vi.stubGlobal("fetch", fetchMock);
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3-beta+test");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3-beta+test");
		expect(fetchMock).toHaveBeenCalledWith("https://pi.dev/api/report-install?version=1.2.3-beta%2Btest", {
			signal: expect.any(AbortSignal),
		});
	});
});
