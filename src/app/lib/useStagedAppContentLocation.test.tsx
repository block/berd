import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNavigationLocation } from "../types/appNavigation";
import { useStagedAppContentLocation } from "./useStagedAppContentLocation";

function mockAnimationFrames() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return {
    runAll: () => {
      for (const [frameId, callback] of Array.from(callbacks)) {
        callbacks.delete(frameId);
        callback(performance.now());
      }
    },
  };
}

const homeLocation: AppNavigationLocation = { view: "home" };
const chatLocation: AppNavigationLocation = {
  view: "chat",
  sessionId: "session-1",
};
const otherChatLocation: AppNavigationLocation = {
  view: "chat",
  sessionId: "session-2",
};
const settingsLocation: AppNavigationLocation = {
  view: "settings",
  settingsSection: "appearance",
};
const otherSettingsLocation: AppNavigationLocation = {
  view: "settings",
  settingsSection: "notifications",
};
const skillsLocation: AppNavigationLocation = {
  view: "skills",
  skillId: null,
};

type HookProps = {
  location: AppNavigationLocation;
};

function renderStagedLocation(initialLocation: AppNavigationLocation) {
  const initialProps: HookProps = { location: initialLocation };

  return renderHook(
    ({ location }: HookProps) => useStagedAppContentLocation(location),
    { initialProps },
  );
}

describe("useStagedAppContentLocation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes renderedLocation to the target location", () => {
    const { result } = renderHook(() =>
      useStagedAppContentLocation(homeLocation),
    );

    expect(result.current).toEqual({
      targetLocation: homeLocation,
      renderedLocation: homeLocation,
      isPreparingContent: false,
    });
  });

  it("keeps the previous rendered location for secondary routes until after the next paint", () => {
    const frames = mockAnimationFrames();
    const { result, rerender } = renderStagedLocation(homeLocation);

    rerender({ location: settingsLocation });

    expect(result.current.targetLocation).toBe(settingsLocation);
    expect(result.current.renderedLocation).toBe(homeLocation);
    expect(result.current.isPreparingContent).toBe(true);

    act(() => {
      frames.runAll();
      vi.advanceTimersByTime(0);
    });

    expect(result.current.renderedLocation).toBe(settingsLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("renders chat routes immediately without app-level staging", () => {
    const { result, rerender } = renderStagedLocation(homeLocation);

    rerender({ location: chatLocation });

    expect(result.current.targetLocation).toBe(chatLocation);
    expect(result.current.renderedLocation).toBe(chatLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("renders home routes immediately without app-level staging", () => {
    const { result, rerender } = renderStagedLocation(settingsLocation);

    rerender({ location: homeLocation });

    expect(result.current.targetLocation).toBe(homeLocation);
    expect(result.current.renderedLocation).toBe(homeLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("renders settings section changes immediately without app-level staging", () => {
    const { result, rerender } = renderStagedLocation(settingsLocation);

    rerender({ location: otherSettingsLocation });

    expect(result.current.targetLocation).toBe(otherSettingsLocation);
    expect(result.current.renderedLocation).toBe(otherSettingsLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("renders chat session changes immediately", () => {
    const { result, rerender } = renderStagedLocation(chatLocation);

    rerender({ location: otherChatLocation });

    expect(result.current.targetLocation).toBe(otherChatLocation);
    expect(result.current.renderedLocation).toBe(otherChatLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("cancels stale pending updates during rapid navigation", () => {
    const frames = mockAnimationFrames();
    const { result, rerender } = renderStagedLocation(homeLocation);

    rerender({ location: settingsLocation });
    rerender({ location: skillsLocation });

    expect(result.current.targetLocation).toBe(skillsLocation);
    expect(result.current.renderedLocation).toBe(homeLocation);

    act(() => {
      frames.runAll();
      vi.advanceTimersByTime(0);
    });

    expect(result.current.renderedLocation).toBe(skillsLocation);
  });

  it("cancels a pending non-chat update when chat becomes the target", () => {
    const frames = mockAnimationFrames();
    const { result, rerender } = renderStagedLocation(homeLocation);

    rerender({ location: settingsLocation });
    rerender({ location: chatLocation });

    expect(result.current.targetLocation).toBe(chatLocation);
    expect(result.current.renderedLocation).toBe(chatLocation);
    expect(result.current.isPreparingContent).toBe(false);

    act(() => {
      frames.runAll();
      vi.advanceTimersByTime(0);
    });

    expect(result.current.renderedLocation).toBe(chatLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });

  it("does not apply a pending update after unmount", () => {
    const frames = mockAnimationFrames();
    const consoleErrorSpy = vi.spyOn(console, "error");
    const { rerender, unmount } = renderStagedLocation(homeLocation);

    rerender({ location: settingsLocation });
    unmount();

    act(() => {
      frames.runAll();
      vi.advanceTimersByTime(120);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("uses navigation equality instead of object identity", () => {
    const { result, rerender } = renderStagedLocation(settingsLocation);

    rerender({ location: { view: "settings", settingsSection: "appearance" } });

    expect(result.current.renderedLocation).toBe(settingsLocation);
    expect(result.current.isPreparingContent).toBe(false);
  });
});
