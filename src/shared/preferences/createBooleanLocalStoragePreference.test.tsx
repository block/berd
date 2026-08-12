import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createBooleanLocalStoragePreference } from "./createBooleanLocalStoragePreference";

const STORAGE_KEY = "test:boolean-preference";
const CHANGED_EVENT = "test:boolean-preference-changed";

const preference = createBooleanLocalStoragePreference({
  storageKey: STORAGE_KEY,
  changedEvent: CHANGED_EVENT,
  defaultValue: false,
});

describe("createBooleanLocalStoragePreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("updates subscribers after cross-window storage changes", () => {
    const { result } = renderHook(() => preference.useValue());

    localStorage.setItem(STORAGE_KEY, "true");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    expect(result.current.enabled).toBe(true);
  });

  it("ignores cross-window changes to unrelated preferences", () => {
    const { result } = renderHook(() => preference.useValue());

    localStorage.setItem(STORAGE_KEY, "true");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "test:other-preference" }),
      );
    });

    expect(result.current.enabled).toBe(false);
  });
});
