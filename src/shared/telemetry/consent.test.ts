import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTelemetrySettings = vi.hoisted(() => vi.fn());
const setTelemetryEnabled = vi.hoisted(() => vi.fn());
const perfLog = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/telemetrySettings", () => ({
  getTelemetrySettings,
  setTelemetryEnabled,
}));
vi.mock("@/shared/lib/perfLog", () => ({ perfLog }));

// Re-import per test so the store singleton and the one-shot load guard are
// fresh — each test is its own renderer session.
async function loadConsent() {
  vi.resetModules();
  return await import("./consent");
}

// Lets a test order the boot read's resolution against a consent write.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The rejection path is asserted after the fact, so nothing awaits this
  // promise directly; swallow it here to keep it from surfacing as unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  getTelemetrySettings.mockReset().mockResolvedValue({ enabled: true });
  setTelemetryEnabled.mockReset();
  perfLog.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("telemetry consent", () => {
  it("fails closed until the persisted setting has affirmatively loaded", async () => {
    const consent = await loadConsent();

    expect(consent.telemetryConsentSettled()).toBe(false);
    expect(consent.telemetryConsentGranted()).toBe(false);

    consent.ensureTelemetryConsentLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consent.telemetryConsentSettled()).toBe(true);
    expect(consent.telemetryConsentGranted()).toBe(true);
  });

  it("loads the setting once per renderer, not once per caller", async () => {
    const consent = await loadConsent();

    consent.ensureTelemetryConsentLoaded();
    consent.ensureTelemetryConsentLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getTelemetrySettings).toHaveBeenCalledTimes(1);
  });

  it("settles a failed read as disabled rather than leaving consent undecided", async () => {
    getTelemetrySettings.mockRejectedValue(new Error("state went away"));
    const consent = await loadConsent();

    consent.ensureTelemetryConsentLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consent.telemetryConsentSettled()).toBe(true);
    expect(consent.telemetryConsentGranted()).toBe(false);
    expect(perfLog).toHaveBeenCalledWith(
      "[telemetry] failed to load the telemetry setting: Error: state went away",
    );
  });

  it("does not let a stale read clobber a write that already settled", async () => {
    // The welcome page's fire-and-forget write can land while the boot read is
    // still in flight, so the read must not settle a store a write already owns.
    const read = deferred<{ enabled: boolean }>();
    getTelemetrySettings.mockReturnValue(read.promise);
    setTelemetryEnabled.mockResolvedValue({ enabled: true });
    const consent = await loadConsent();

    consent.ensureTelemetryConsentLoaded();
    await consent.updateTelemetryEnabled(true);

    read.resolve({ enabled: false });
    await flushMicrotasks();

    expect(consent.telemetryConsentGranted()).toBe(true);
    expect(consent.useTelemetryConsentStore.getState()).toEqual({
      loaded: true,
      enabled: true,
    });
  });

  it("does not let a failed read force-disable consent a write already granted", async () => {
    const read = deferred<{ enabled: boolean }>();
    getTelemetrySettings.mockReturnValue(read.promise);
    setTelemetryEnabled.mockResolvedValue({ enabled: true });
    const consent = await loadConsent();

    consent.ensureTelemetryConsentLoaded();
    await consent.updateTelemetryEnabled(true);

    read.reject(new Error("state went away"));
    await flushMicrotasks();

    expect(consent.telemetryConsentGranted()).toBe(true);
    expect(perfLog).toHaveBeenCalledWith(
      "[telemetry] failed to load the telemetry setting: Error: state went away",
    );
  });

  it("grants consent in enforced builds without touching the persisted setting", async () => {
    vi.stubEnv("VITE_TELEMETRY_ENFORCED", "1");
    const consent = await loadConsent();

    expect(consent.telemetryConsentEnforced()).toBe(true);
    expect(consent.telemetryConsentSettled()).toBe(true);
    expect(consent.telemetryConsentGranted()).toBe(true);

    consent.ensureTelemetryConsentLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTelemetrySettings).not.toHaveBeenCalled();
  });

  it("reflects the value the native side actually stored on update", async () => {
    setTelemetryEnabled.mockResolvedValue({ enabled: true });
    const consent = await loadConsent();

    await consent.updateTelemetryEnabled(true);

    expect(setTelemetryEnabled).toHaveBeenCalledWith(true);
    expect(consent.telemetryConsentGranted()).toBe(true);
    expect(consent.useTelemetryConsentStore.getState()).toEqual({
      loaded: true,
      enabled: true,
    });
  });

  it("propagates a failed write so the toggle never shows a state that was not persisted", async () => {
    setTelemetryEnabled.mockRejectedValue(new Error("read-only disk"));
    const consent = await loadConsent();

    await expect(consent.updateTelemetryEnabled(true)).rejects.toThrow(
      "read-only disk",
    );
    expect(consent.telemetryConsentGranted()).toBe(false);
  });
});
