import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWidgetGestureFreeze } from "./useWidgetGestureFreeze";

describe("useWidgetGestureFreeze", () => {
  it("captures synchronously when a canvas gesture starts", () => {
    const capture = vi.fn(() => "data:image/png;base64,pointerdown");
    const { result, rerender } = renderHook(
      ({ active }) => useWidgetGestureFreeze(active, capture),
      { initialProps: { active: false } },
    );

    rerender({ active: true });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("data:image/png;base64,pointerdown");
  });

  it("captures a snapshot when a canvas gesture starts", async () => {
    const capture = vi.fn(() => "data:image/png;base64,abc");
    const { result, rerender } = renderHook(
      ({ active }) => useWidgetGestureFreeze(active, capture),
      { initialProps: { active: false } },
    );

    expect(result.current).toBeNull();

    rerender({ active: true });

    await waitFor(() => {
      expect(result.current).toBe("data:image/png;base64,abc");
    });
    expect(capture).toHaveBeenCalled();
  });

  it("reuses the previous successful frame when a later capture fails", async () => {
    const capture = vi
      .fn<() => string | null>()
      .mockReturnValueOnce("data:image/png;base64,previous")
      .mockReturnValue("data:image/png;base64,previous");
    const { result, rerender } = renderHook(
      ({ active }) => useWidgetGestureFreeze(active, capture),
      { initialProps: { active: true } },
    );

    await waitFor(() => {
      expect(result.current).toBe("data:image/png;base64,previous");
    });
    rerender({ active: false });
    capture.mockReturnValue(null);
    rerender({ active: true });

    expect(result.current).toBe("data:image/png;base64,previous");
  });

  it("holds the snapshot briefly after the gesture ends", async () => {
    const capture = vi.fn(() => "data:image/png;base64,abc");
    const { result, rerender } = renderHook(
      ({ active }) => useWidgetGestureFreeze(active, capture),
      { initialProps: { active: true } },
    );

    await waitFor(() => {
      expect(result.current).toBe("data:image/png;base64,abc");
    });

    rerender({ active: false });
    expect(result.current).toBe("data:image/png;base64,abc");

    await waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: 700 },
    );
  });
});
