import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { recordInstallTelemetry } from "../src/core/telemetry.ts";
import { getNewEntries } from "../src/utils/changelog.ts";

const mocks = vi.hoisted(() => ({
	destroy: vi.fn(),
	request: vi.fn(),
	envProxyAgent: vi.fn(),
	instances: [] as Array<{ listenerCount(event: string): number }>,
}));

vi.mock("undici", async () => {
	const { EventEmitter } = await import("node:events");
	class EnvHttpProxyAgent extends EventEmitter {
		destroy = mocks.destroy;
		constructor(options: unknown) {
			super();
			mocks.instances.push(this);
			mocks.envProxyAgent(options);
		}
	}
	return { EnvHttpProxyAgent, request: mocks.request };
});

beforeEach(() => {
	mocks.request.mockResolvedValue({ body: { dump: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	mocks.instances.length = 0;
});

describe("install telemetry", () => {
	it("does not advance the version marker while offline", () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBeUndefined();
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it("advances the marker without sending when telemetry is disabled", () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });

		recordInstallTelemetry(settingsManager, "1.2.3");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3");
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it("sends only the version through the env-proxy dispatcher and tears it down", async () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PI_TELEMETRY", undefined);
		const settingsManager = SettingsManager.inMemory();

		recordInstallTelemetry(settingsManager, "1.2.3-beta+test");

		expect(settingsManager.getLastChangelogVersion()).toBe("1.2.3-beta+test");
		expect(mocks.envProxyAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				proxyTunnel: true,
				connect: expect.objectContaining({ timeout: 5000 }),
				clientFactory: expect.any(Function),
				factory: expect.any(Function),
			}),
		);
		const dispatcher = mocks.instances[0];
		expect(dispatcher.listenerCount("error")).toBeGreaterThan(0);
		expect(mocks.request).toHaveBeenCalledWith(
			"https://pi.dev/api/report-install?version=1.2.3-beta%2Btest",
			expect.objectContaining({
				dispatcher: expect.objectContaining({ destroy: mocks.destroy }),
				signal: expect.any(AbortSignal),
			}),
		);
		await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
	});

	it("compares prerelease markers by their changelog version", () => {
		const entries = [{ major: 1, minor: 2, patch: 3, content: "" }];

		expect(getNewEntries(entries, "1.2.3-beta.1+build.2")).toEqual([]);
	});
});
