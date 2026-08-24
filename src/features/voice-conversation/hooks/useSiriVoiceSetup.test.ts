import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiriVoiceStatus } from "../api/siriVoice";
import {
  availableLocales,
  canonicalLocale,
  chooseAvailableLocale,
  initialSelectedVoiceLocale,
  useSiriVoiceSetup,
} from "./useSiriVoiceSetup";

const apiMocks = vi.hoisted(() => ({
  downloadSiriVoice: vi.fn(),
  getSiriVoiceStatus: vi.fn(),
  selectSiriVoice: vi.fn(),
}));

vi.mock("../api/siriVoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/siriVoice")>()),
  downloadSiriVoice: apiMocks.downloadSiriVoice,
  getSiriVoiceStatus: apiMocks.getSiriVoiceStatus,
  selectSiriVoice: apiMocks.selectSiriVoice,
}));

const originalTauriInternals = window.__TAURI_INTERNALS__;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function status(language: string, name: string): SiriVoiceStatus {
  return {
    supported: true,
    availableLanguages: [language],
    selectedVoice: { name, language },
    selectedVoiceInstalled: true,
    playbackSpeed: 1,
    voices: [{ name, language, sizeBytes: 1, installed: true }],
  };
}

beforeEach(() => {
  apiMocks.downloadSiriVoice.mockReset();
  apiMocks.getSiriVoiceStatus.mockReset();
  apiMocks.selectSiriVoice.mockReset();
  apiMocks.downloadSiriVoice.mockResolvedValue(undefined);
  apiMocks.selectSiriVoice.mockResolvedValue(undefined);
  window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
});

afterEach(() => {
  window.__TAURI_INTERNALS__ = originalTauriInternals;
});

describe("Siri voice locales", () => {
  it("preserves exact regional variants", () => {
    expect(availableLocales(["en_US", "en-AU", "en-IN", "en-US"])).toEqual([
      "en-AU",
      "en-IN",
      "en-US",
    ]);
    expect(canonicalLocale("en_US")).toBe("en-US");
  });

  it("uses the exact system locale when it is available", () => {
    expect(chooseAvailableLocale("en-US", ["en-AU", "en-IN", "en-US"])).toBe(
      "en-US",
    );
  });

  it("falls back to a regional variant without adding an all-language option", () => {
    expect(chooseAvailableLocale("en-CA", ["en-AU", "en-IN"])).toBe("en-AU");
  });

  it("opens on the selected voice's regional locale", () => {
    expect(
      initialSelectedVoiceLocale("en-US", ["en-AU", "en-US"], {
        name: "Catherine",
        language: "en_AU",
      }),
    ).toBe("en-AU");
  });

  it("ignores an old-language failure after the current language succeeds", async () => {
    const oldRequest = deferred<SiriVoiceStatus>();
    const currentRequest = deferred<SiriVoiceStatus>();
    apiMocks.getSiriVoiceStatus.mockImplementation((language: string) =>
      language === "en-AU" ? currentRequest.promise : oldRequest.promise,
    );
    const { result } = renderHook(() => useSiriVoiceSetup(true));

    await waitFor(() => expect(apiMocks.getSiriVoiceStatus).toHaveBeenCalled());
    act(() => result.current.setLanguage("en-AU"));
    await waitFor(() =>
      expect(apiMocks.getSiriVoiceStatus).toHaveBeenCalledWith("en-AU", {
        coalesce: true,
      }),
    );

    currentRequest.resolve(status("en-AU", "Catherine"));
    await waitFor(() =>
      expect(result.current.status?.selectedVoice?.name).toBe("Catherine"),
    );

    oldRequest.reject(new Error("Old catalog failed"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status?.selectedVoice?.name).toBe("Catherine");
    expect(result.current.error).toBeNull();
    expect(result.current.statusError).toBeNull();
  });

  it("ignores a refresh failure after Siri setup is disabled", async () => {
    const focusRefresh = deferred<SiriVoiceStatus>();
    apiMocks.getSiriVoiceStatus
      .mockResolvedValueOnce(status("en-US", "Aaron"))
      .mockReturnValueOnce(focusRefresh.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSiriVoiceSetup(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(result.current.status?.selectedVoice?.name).toBe("Aaron"),
    );

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(apiMocks.getSiriVoiceStatus).toHaveBeenCalledTimes(2),
    );
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.status).toBeNull());

    focusRefresh.reject(new Error("Stale focus refresh failed"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.statusError).toBeNull();
  });

  it("selects the exact Siri voice after its download completes", async () => {
    const initialStatus = status("en-US", "Aaron");
    apiMocks.getSiriVoiceStatus.mockResolvedValue(initialStatus);
    const { result } = renderHook(() => useSiriVoiceSetup(true));
    await waitFor(() => expect(result.current.status).toEqual(initialStatus));

    const voice = {
      name: "Quinn",
      language: "en-US",
      sizeBytes: 310_500_000,
      installed: false,
    };
    await act(async () => {
      await result.current.downloadVoice(voice);
    });

    const selection = { name: "Quinn", language: "en-US" };
    expect(apiMocks.downloadSiriVoice).toHaveBeenCalledWith(selection);
    expect(apiMocks.selectSiriVoice).toHaveBeenCalledWith(selection);
    expect(apiMocks.downloadSiriVoice.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.selectSiriVoice.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
