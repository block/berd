import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWidgetGestureFreeze } from "./useWidgetGestureFreeze";

describe("useWidgetGestureFreeze", () => {
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
