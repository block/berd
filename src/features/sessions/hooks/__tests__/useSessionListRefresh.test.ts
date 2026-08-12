import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionListRefresh } from "../useSessionListRefresh";

describe("useSessionListRefresh", () => {
  let loadSessionsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    loadSessionsSpy = vi
      .spyOn(useChatSessionStore.getState(), "loadSessions")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    loadSessionsSpy.mockRestore();
  });

  it("calls loadSessions on window focus", () => {
    renderHook(() => useSessionListRefresh());
    window.dispatchEvent(new Event("focus"));
    expect(loadSessionsSpy).toHaveBeenCalledTimes(1);
  });

  it("calls loadSessions every 60 seconds", () => {
    renderHook(() => useSessionListRefresh());
    expect(loadSessionsSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(loadSessionsSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(loadSessionsSpy).toHaveBeenCalledTimes(2);
  });

  it("clears the interval on unmount", () => {
    const { unmount } = renderHook(() => useSessionListRefresh());
    unmount();
    vi.advanceTimersByTime(120_000);
    expect(loadSessionsSpy).not.toHaveBeenCalled();
  });

  it("removes the focus listener on unmount", () => {
    const { unmount } = renderHook(() => useSessionListRefresh());
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(loadSessionsSpy).not.toHaveBeenCalled();
  });

  it("swallows errors so the timer keeps running", async () => {
    loadSessionsSpy.mockRejectedValueOnce(new Error("acp unavailable"));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderHook(() => useSessionListRefresh());
    window.dispatchEvent(new Event("focus"));

    // Allow the rejected promise to settle before advancing the timer.
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });

    vi.advanceTimersByTime(60_000);
    expect(loadSessionsSpy).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});
