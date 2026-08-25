import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicrophonePermissionStatus } from "../api/microphonePermission";
import { useMicrophonePermission } from "./useMicrophonePermission";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("../api/microphonePermission", () => ({
  getMicrophonePermissionStatus: mocks.getStatus,
  openMicrophonePrivacySettings: mocks.openSettings,
}));

const originalTauriInternals = window.__TAURI_INTERNALS__;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.getStatus.mockReset();
  mocks.openSettings.mockReset();
  window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
});

afterEach(() => {
  window.__TAURI_INTERNALS__ = originalTauriInternals;
  vi.restoreAllMocks();
});

describe("useMicrophonePermission", () => {
  it("loads the current permission status", async () => {
    mocks.getStatus.mockResolvedValue("denied");

    const { result } = renderHook(() => useMicrophonePermission());

    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.openSettingsError).toBe(false);
  });

  it("refreshes permission when the window regains focus", async () => {
    mocks.getStatus
      .mockResolvedValueOnce("denied")
      .mockResolvedValueOnce("authorized");
    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(result.current.status).toBe("denied"));

    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(result.current.status).toBe("authorized"));
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores an older permission response after a focus refresh", async () => {
    const initial = deferred<MicrophonePermissionStatus>();
    mocks.getStatus
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce("authorized");
    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.status).toBe("authorized"));

    initial.resolve("denied");
    await act(async () => Promise.resolve());
    expect(result.current.status).toBe("authorized");
  });

  it.each([
    ["disabled", false, true],
    ["outside Tauri", true, false],
  ])("does not query when %s", (_name, enabled, inTauri) => {
    if (!inTauri) window.__TAURI_INTERNALS__ = undefined;

    const { result } = renderHook(() => useMicrophonePermission(enabled));

    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it("reports a localized settings-open error without exposing its cause", async () => {
    const cause = { message: "native details" };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.getStatus.mockResolvedValue("denied");
    mocks.openSettings.mockRejectedValue(cause);
    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(result.current.status).toBe("denied"));

    await act(() => result.current.openSettings());

    expect(result.current.openSettingsError).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to open microphone settings",
      cause,
    );
  });

  it("does not report a settings-open error when a focus refresh fails", async () => {
    const cause = { message: "status unavailable" };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.getStatus
      .mockResolvedValueOnce("denied")
      .mockRejectedValueOnce(cause);
    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(result.current.status).toBe("denied"));

    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    expect(result.current.openSettingsError).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to read microphone permission",
      cause,
    );
  });
});
