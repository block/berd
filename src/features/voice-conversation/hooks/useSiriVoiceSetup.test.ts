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

const mockGetSiriVoiceStatus = vi.hoisted(() => vi.fn());

vi.mock("../api/siriVoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/siriVoice")>()),
  getSiriVoiceStatus: mockGetSiriVoiceStatus,
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
  mockGetSiriVoiceStatus.mockReset();
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
    mockGetSiriVoiceStatus.mockImplementation((language: string) =>
      language === "en-AU" ? currentRequest.promise : oldRequest.promise,
    );
    const { result } = renderHook(() => useSiriVoiceSetup(true));

    await waitFor(() => expect(mockGetSiriVoiceStatus).toHaveBeenCalled());
    act(() => result.current.setLanguage("en-AU"));
    await waitFor(() =>
      expect(mockGetSiriVoiceStatus).toHaveBeenCalledWith("en-AU", {
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
});
