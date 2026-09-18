import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { recordInstallTelemetry } from "../src/core/telemetry.ts";
import { getNewEntries } from "../src/utils/changelog.ts";

const httpsGetMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ get: httpsGetMock }));

function mockRequest() {
	const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
	httpsGetMock.mockReturnValue(request);
	return request;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("install telemetry", () => {
	it("does not advance the version marker while offline", () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBeUndefined();
		expect(httpsGetMock).not.toHaveBeenCalled();
	});

	it("advances the marker without sending when telemetry is disabled", () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3");
		expect(httpsGetMock).not.toHaveBeenCalled();
	});

	it("sends only the version payload without keeping the process alive", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const request = mockRequest();
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3-beta+test");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3-beta+test");
		expect(httpsGetMock).toHaveBeenCalledWith(
			"https://pi.dev/api/report-install?version=1.2.3-beta%2Btest",
			expect.any(Function),
		);
		const socket = { unref: vi.fn() };
		request.emit("socket", socket);
		expect(socket.unref).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(5000);
		expect(request.destroy).toHaveBeenCalledOnce();
	});

	it("compares prerelease markers by their changelog version", () => {
		const entries = [{ major: 1, minor: 2, patch: 3, content: "" }];

		expect(getNewEntries(entries, "1.2.3-beta.1+build.2")).toEqual([]);
	});
});
