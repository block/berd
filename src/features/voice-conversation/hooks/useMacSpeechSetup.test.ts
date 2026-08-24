import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MacSpeechStatus } from "../api/macSpeech";
import { mergeMacSpeechStatus, useMacSpeechSetup } from "./useMacSpeechSetup";

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../api/macSpeech", () => ({
  getMacSpeechStatus: api.getStatus,
  installMacSpeechModel: api.install,
  listenToMacSpeechStatus: api.listen,
}));

const originalTauriInternals = window.__TAURI_INTERNALS__;

function status(overrides: Partial<MacSpeechStatus> = {}): MacSpeechStatus {
  return {
    supported: true,
    unavailableReason: null,
    locale: "en-US",
    localeSupported: true,
    modelInstalled: false,
    installing: true,
    progress: 0.5,
    error: null,
    revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  api.getStatus.mockReset();
  api.install.mockReset();
  api.listen.mockReset();
  api.listen.mockResolvedValue(vi.fn());
  window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
});

afterEach(() => {
  window.__TAURI_INTERNALS__ = originalTauriInternals;
});

it("keeps terminal status when delayed progress arrives", () => {
  const completed = status({
    modelInstalled: true,
    installing: false,
    progress: null,
    revision: 3,
  });
  const delayedProgress = status({ revision: 2, progress: 0.9 });

  expect(mergeMacSpeechStatus(completed, delayedProgress)).toBe(completed);
});

it("ignores an old refresh failure after a newer status event", async () => {
  let rejectRefresh: ((error: Error) => void) | undefined;
  let emitStatus: ((next: MacSpeechStatus) => void) | undefined;
  api.getStatus.mockReturnValue(
    new Promise((_, reject) => {
      rejectRefresh = reject;
    }),
  );
  api.listen.mockImplementation(async (listener) => {
    emitStatus = listener;
    return vi.fn();
  });
  const { result } = renderHook(() => useMacSpeechSetup(true));
  await waitFor(() => expect(emitStatus).toBeDefined());

  act(() => {
    emitStatus?.(
      status({
        modelInstalled: true,
        installing: false,
        progress: null,
        revision: 2,
      }),
    );
  });
  await act(async () => {
    rejectRefresh?.(new Error("stale timeout"));
    await Promise.resolve();
  });

  expect(result.current.status?.revision).toBe(2);
  expect(result.current.error).toBeNull();
});

it("clears optimistic installation state when the command fails", async () => {
  api.getStatus.mockResolvedValue(status());
  api.install.mockRejectedValue(new Error("download failed"));
  const { result } = renderHook(() => useMacSpeechSetup(true));
  await waitFor(() => expect(result.current.status?.installing).toBe(true));

  await act(() => result.current.install());

  expect(result.current.status).toMatchObject({
    installing: false,
    progress: null,
    error: "Error: download failed",
  });
  expect(result.current.error).toBe("Error: download failed");
});
