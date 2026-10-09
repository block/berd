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
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
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
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
    });
  });

  it("preserves existing disabled channels while adding default sounds", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ enabled: false, inApp: false, desktop: false }),
    );
    expect(getNotificationPrefs()).toEqual({
      enabled: false,
      inApp: false,
      desktop: false,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
    });
  });

  it("normalizes invalid stored sounds to the default", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ inAppSound: "missing.mp3", desktopSound: "silent" }),
    );
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "silent",
      toastDurationSeconds: 8,
    });
  });

  it("clamps an out-of-range stored toast duration to the maximum", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ toastDurationSeconds: 999 }),
    );
    expect(getNotificationPrefs().toastDurationSeconds).toBe(60);
  });

  it("preserves a stored never-dismiss toast duration", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ toastDurationSeconds: 0 }),
    );
    expect(getNotificationPrefs().toastDurationSeconds).toBe(0);
  });

  it("recovers a corrupted negative stored toast duration to the default instead of never-dismiss", () => {
    localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ toastDurationSeconds: -5 }),
    );
    expect(getNotificationPrefs().toastDurationSeconds).toBe(8);
  });

  it("returns defaults when stored value is invalid JSON", () => {
    localStorage.setItem("goose:notifications", "not-json");
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
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
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
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
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
    });
  });

  it("merges multiple sequential updates", () => {
    setNotificationPrefs({ desktop: false });
    setNotificationPrefs({ inApp: false });
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: false,
      desktop: false,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 8,
    });
  });

  it("does not throw when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => setNotificationPrefs({ enabled: false })).not.toThrow();
  });
});
