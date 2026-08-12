import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMultiWorkspaceEnabled,
  MULTI_WORKSPACE_STORAGE_KEY,
  setMultiWorkspaceEnabled,
  useMultiWorkspacePreference,
} from "./multiWorkspacePreference";

describe("multiWorkspacePreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to disabled and supports imperative reads and writes", () => {
    expect(getMultiWorkspaceEnabled()).toBe(false);

    setMultiWorkspaceEnabled(true);

    expect(getMultiWorkspaceEnabled()).toBe(true);
    expect(localStorage.getItem(MULTI_WORKSPACE_STORAGE_KEY)).toBe("true");
  });

  it("updates React subscribers after same-window changes", () => {
    const { result } = renderHook(() => useMultiWorkspacePreference());

    expect(result.current.enabled).toBe(false);

    act(() => result.current.setEnabled(true));

    expect(result.current.enabled).toBe(true);
  });

  it("updates React subscribers after cross-window changes", () => {
    const { result } = renderHook(() => useMultiWorkspacePreference());

    localStorage.setItem(MULTI_WORKSPACE_STORAGE_KEY, "true");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: MULTI_WORKSPACE_STORAGE_KEY }),
      );
    });

    expect(result.current.enabled).toBe(true);
  });

  it.each([
    true,
    false,
  ])("migrates an explicit legacy experiment choice of %s", (enabled) => {
    localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        autoEnable: !enabled,
        experiments: {
          "multi-workspace": { enabled },
        },
      }),
    );

    expect(getMultiWorkspaceEnabled()).toBe(enabled);
    expect(localStorage.getItem(MULTI_WORKSPACE_STORAGE_KEY)).toBe(
      String(enabled),
    );
  });

  it("does not migrate unsupported experiment storage versions", () => {
    localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 3,
        experiments: {
          "multi-workspace": { enabled: true },
        },
      }),
    );

    expect(getMultiWorkspaceEnabled()).toBe(false);
    expect(localStorage.getItem(MULTI_WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it("does not migrate experiment defaults or unknown state", () => {
    localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        autoEnable: true,
        experiments: {
          "future-experiment": { enabled: true },
        },
      }),
    );

    expect(getMultiWorkspaceEnabled()).toBe(false);
    expect(localStorage.getItem(MULTI_WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it("does not overwrite a normal setting with legacy state", () => {
    localStorage.setItem(MULTI_WORKSPACE_STORAGE_KEY, "false");
    localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        experiments: {
          "multi-workspace": { enabled: true },
        },
      }),
    );

    expect(getMultiWorkspaceEnabled()).toBe(false);
  });
});
