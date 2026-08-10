import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_ARCHIVE_CHANGED_EVENT,
  AUTO_ARCHIVE_CONSENT_STORAGE_KEY,
  AUTO_ARCHIVE_STORAGE_KEY,
  getAutoArchiveAfter,
  getAutoArchiveAfterMs,
  setAutoArchiveAfter,
} from "../autoArchivePreference";

describe("auto archive preference", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to never and rejects unconfirmed or invalid persisted values", () => {
    expect(getAutoArchiveAfter()).toBe("never");

    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, "14-days");
    expect(getAutoArchiveAfter()).toBe("never");

    localStorage.setItem(AUTO_ARCHIVE_CONSENT_STORAGE_KEY, "true");
    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, "tomorrow-ish");
    expect(getAutoArchiveAfter()).toBe("never");
  });

  it("persists changes and notifies mounted consumers", () => {
    const listener = vi.fn();
    window.addEventListener(AUTO_ARCHIVE_CHANGED_EVENT, listener);

    setAutoArchiveAfter("30-days");

    expect(localStorage.getItem(AUTO_ARCHIVE_STORAGE_KEY)).toBe("30-days");
    expect(localStorage.getItem(AUTO_ARCHIVE_CONSENT_STORAGE_KEY)).toBe("true");
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTO_ARCHIVE_CHANGED_EVENT, listener);
  });

  it("converts configured durations to milliseconds", () => {
    expect(getAutoArchiveAfterMs("never")).toBeNull();
    expect(getAutoArchiveAfterMs("7-days")).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
