import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTelemetrySettings, setTelemetryEnabled } from "./telemetrySettings";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("telemetry settings api", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("reads the setting through the native command", async () => {
    mockInvoke.mockResolvedValueOnce({ enabled: true });

    await expect(getTelemetrySettings()).resolves.toEqual({ enabled: true });
    expect(mockInvoke).toHaveBeenCalledWith("get_telemetry_settings");
  });

  it("writes the setting through the native command and returns the stored value", async () => {
    mockInvoke.mockResolvedValueOnce({ enabled: false });

    await expect(setTelemetryEnabled(false)).resolves.toEqual({
      enabled: false,
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_telemetry_enabled", {
      enabled: false,
    });
  });

  it("rejects a malformed native answer instead of guessing at consent", async () => {
    mockInvoke.mockResolvedValueOnce({ enabled: "yes" });

    await expect(getTelemetrySettings()).rejects.toThrow();
  });

  describe("transient startup retries", () => {
    // Telemetry initializes at renderer boot — exactly the window where the
    // webview can outrun `app.manage(TelemetryAuthState)` in `setup()`. That
    // race must read as a retried transient, not as "no consent".
    const stateNotManagedError =
      "state not managed for field `state` on command `get_telemetry_settings`. You must call `.manage()` before using this command";

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-retries a transient "state not managed" rejection and ultimately succeeds', async () => {
      mockInvoke
        .mockRejectedValueOnce(stateNotManagedError)
        .mockResolvedValueOnce({ enabled: true });

      const promise = getTelemetrySettings();
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toEqual({ enabled: true });
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it("propagates genuine command failures immediately", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("disk unavailable"));

      await expect(getTelemetrySettings()).rejects.toThrow("disk unavailable");
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });
});
