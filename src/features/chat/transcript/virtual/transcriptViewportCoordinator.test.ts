import { describe, expect, it, vi } from "vitest";
import type { TranscriptVirtualEngine } from "./transcriptVirtualEngine";
import { TranscriptViewportCoordinator } from "./transcriptViewportCoordinator";
import type {
  TranscriptVirtualControllerState,
  TranscriptVirtualDiagnostics,
  TranscriptVirtualRangeSnapshot,
} from "./transcriptVirtualTypes";

function createHarness() {
  const container = document.createElement("div");
  let scrollTop = 100;
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(1600, Math.max(0, value));
      },
    },
  });
  container.getBoundingClientRect = () =>
    ({ top: 0, width: 800, height: 400 }) as DOMRect;

  const state = {
    scrollTop: 100,
    viewportHeight: 400,
    widthScope: "w:800",
    footerHeight: 0,
    bottomScrollTop: 1600,
  } as TranscriptVirtualControllerState;
  const syncViewport = vi.fn((geometry) => {
    state.scrollTop = geometry.scrollTop;
    return { correction: null };
  });
  const setRows = vi.fn(() => ({
    correction: {
      previousScrollTop: 100,
      nextScrollTop: 900,
      delta: 800,
      reason: "row-anchor" as const,
    },
  }));
  const engine = {
    engineKind: "fake",
    setScrollWritesSuspended: vi.fn(),
    reset: vi.fn(),
    setRows,
    syncViewport,
    applyMeasuredHeight: vi.fn(() => ({ accepted: false, correction: null })),
    scrollToRow: vi.fn(() => ({ found: false, correction: null })),
    getRange: vi.fn(() => ({}) as TranscriptVirtualRangeSnapshot),
    getState: () => state,
    getDiagnostics: vi.fn(() => ({}) as TranscriptVirtualDiagnostics),
  } satisfies TranscriptVirtualEngine;
  return {
    container,
    engine,
    coordinator: new TranscriptViewportCoordinator({
      container,
      engine,
      getFooterHeight: () => 0,
    }),
  };
}

describe("TranscriptViewportCoordinator", () => {
  it("coalesces an engine mutation to one browser write and publishes the accepted position", () => {
    const { container, coordinator, engine } = createHarness();
    let writes = 0;
    const descriptor = Object.getOwnPropertyDescriptor(container, "scrollTop");
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: descriptor?.get,
      set: (value: number) => {
        writes += 1;
        descriptor?.set?.call(container, value);
      },
    });

    expect(coordinator.setRows([]).correction).toBeNull();
    expect(writes).toBe(1);
    expect(container.scrollTop).toBe(900);
    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 900 }),
      expect.objectContaining({ source: "browser" }),
    );
  });

  it("reads browser clamping back into the engine", () => {
    const { container, coordinator, engine } = createHarness();
    coordinator.writeScrollTop(4000);
    expect(container.scrollTop).toBe(1600);
    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 1600 }),
      expect.anything(),
    );
  });
});
