import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPrefs,
  setNotificationPrefs,
} from "../notificationPrefs";

describe("getNotificationPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns all-true defaults when nothing is stored", () => {
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });

  it("returns stored values merged with defaults", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ enabled: false }),
    );
    expect(getNotificationPrefs()).toEqual({
      enabled: false,
      inApp: true,
      desktop: true,
    });
  });

  it("returns defaults when stored value is invalid JSON", () => {
    localStorage.setItem("goose:notifications", "not-json");
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });

  it("returns defaults when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });
});

describe("setNotificationPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists a partial update without wiping other keys", () => {
    setNotificationPrefs({ enabled: false });
    expect(getNotificationPrefs()).toEqual({
      enabled: false,
      inApp: true,
      desktop: true,
    });
  });

  it("merges multiple sequential updates", () => {
    setNotificationPrefs({ desktop: false });
    setNotificationPrefs({ inApp: false });
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: false,
      desktop: false,
    });
  });

  it("does not throw when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => setNotificationPrefs({ enabled: false })).not.toThrow();
  });
});
