import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MacSpeechStatus } from "../api/macSpeech";
import { useMacSpeechSetup } from "./useMacSpeechSetup";

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
