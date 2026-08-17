import { describe, expect, it, vi } from "vitest";
import type { TranscriptVirtualEngine } from "./transcriptVirtualEngine";
import { TranscriptViewportCoordinator } from "./transcriptViewportCoordinator";
import type {
  TranscriptScrollAnchor,
  TranscriptScrollCorrection,
  TranscriptScrollOperation,
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
  const syncViewport = vi.fn(
    (geometry): ReturnType<TranscriptVirtualEngine["syncViewport"]> => {
      state.scrollTop = geometry.scrollTop;
      return { correction: null };
    },
  );
  const setRows = vi.fn(
    (): ReturnType<TranscriptVirtualEngine["setRows"]> => ({
      correction: {
        previousScrollTop: 100,
        nextScrollTop: 900,
        delta: 800,
        reason: "row-anchor" as const,
      },
    }),
  );
  let pendingCorrection: ReturnType<
    NonNullable<TranscriptVirtualEngine["getPendingScrollCorrection"]>
  > = null;
  const getPendingScrollCorrection = vi.fn(() => pendingCorrection);
  const engine = {
    engineKind: "fake",
    reset: vi.fn(),
    setRows,
    syncViewport,
    applyMeasuredHeight: vi.fn(() => ({ accepted: false, correction: null })),
    scrollToRow: vi.fn(() => ({ found: false, correction: null })),
    getRange: vi.fn(() => ({}) as TranscriptVirtualRangeSnapshot),
    getPendingScrollCorrection,
    getMeasurementToken: vi.fn(() => null),
    installAuthorityAnchor: vi.fn(
      (
        _anchor: TranscriptScrollAnchor,
        _operation?: TranscriptScrollOperation,
      ) => null as TranscriptScrollCorrection | null,
    ),
    getState: () => state,
    getDiagnostics: vi.fn(() => ({}) as TranscriptVirtualDiagnostics),
  } satisfies TranscriptVirtualEngine;
  return {
    container,
    engine,
    setPendingCorrection: (correction: typeof pendingCorrection) => {
      pendingCorrection = correction;
    },
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
      expect.objectContaining({ source: "browser", userScrollIntent: false }),
    );
  });

  it("clamps a proposal to the live browser scroll range before publishing", () => {
    const { container, coordinator, engine } = createHarness();
    engine.setRows.mockReturnValueOnce({
      correction: {
        previousScrollTop: 100,
        nextScrollTop: 2400,
        delta: 2300,
        reason: "row-anchor",
      },
    });

    coordinator.setRows([]);

    expect(container.scrollTop).toBe(1600);
    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 1600 }),
      expect.objectContaining({ source: "browser" }),
    );
  });

  it("commits a pre-sync proposal when the mutation repeats the pending target", () => {
    const { container, coordinator, engine, setPendingCorrection } =
      createHarness();
    engine.syncViewport.mockImplementationOnce(() => {
      const previousScrollTop = engine.getState().scrollTop;
      return {
        correction: {
          previousScrollTop,
          nextScrollTop: 900,
          delta: 900 - previousScrollTop,
          reason: "row-anchor",
        },
      };
    });
    engine.setRows.mockImplementationOnce(() => {
      setPendingCorrection({
        previousScrollTop: 100,
        nextScrollTop: 900,
        delta: 800,
        reason: "row-anchor",
      });
      return { correction: null };
    });

    coordinator.setRows([]);

    expect(container.scrollTop).toBe(900);
    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 900 }),
      expect.objectContaining({ source: "browser" }),
    );
  });

  it("drops a pre-sync proposal when the mutation cancels it", () => {
    const { container, coordinator, engine, setPendingCorrection } =
      createHarness();
    engine.syncViewport.mockImplementationOnce(() => ({
      correction: {
        previousScrollTop: 100,
        nextScrollTop: 900,
        delta: 800,
        reason: "row-anchor",
      },
    }));
    engine.setRows.mockReturnValueOnce({ correction: null });
    setPendingCorrection(null);

    coordinator.setRows([]);

    expect(container.scrollTop).toBe(100);
  });

  it("preserves a programmatic cause through browser clamp without creating user intent", () => {
    const { container, coordinator, engine } = createHarness();
    const operation = coordinator.beginScrollOperation("target");

    coordinator.writeScrollTop(4000, { operation });

    expect(container.scrollTop).toBe(1600);
    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ scrollTop: 1600 }),
      expect.objectContaining({
        source: "browser",
        userScrollIntent: false,
        operation,
      }),
    );
  });

  it("creates user intent only for an explicitly typed physical input", () => {
    const { coordinator, engine } = createHarness();
    const operation = coordinator.beginScrollOperation("user-input", "wheel");

    coordinator.syncViewport(
      {
        scrollTop: 200,
        viewportHeight: 400,
        widthScope: "w:800",
      },
      { source: "browser", operation },
    );

    expect(engine.syncViewport).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ userScrollIntent: true, operation }),
    );
  });

  it("ignores an acknowledgement from an operation superseded by user input", () => {
    const { container, coordinator, engine } = createHarness();
    const target = coordinator.beginScrollOperation("target");
    coordinator.beginScrollOperation("user-input", "touch");

    coordinator.writeScrollTop(900, { operation: target });

    expect(container.scrollTop).toBe(100);
    expect(engine.syncViewport).not.toHaveBeenCalled();
  });

  it("forwards authority anchors to the wrapped engine and commits its correction", () => {
    const { container, coordinator, engine } = createHarness();
    const installAuthorityAnchor = vi.fn(
      (
        _anchor: TranscriptScrollAnchor,
        operation?: TranscriptScrollOperation,
      ) => ({
        reason: "row-anchor" as const,
        previousScrollTop: 100,
        nextScrollTop: 120,
        delta: 20,
        operation,
      }),
    );
    (
      engine.installAuthorityAnchor as ReturnType<typeof vi.fn>
    ).mockImplementation(installAuthorityAnchor);
    const anchor: TranscriptScrollAnchor = {
      type: "row",
      rowId: "row-1",
      offsetWithinRow: 20,
      anchorRevision: "unused",
    };
    const operation: TranscriptScrollOperation = {
      generation: 4,
      cause: "target",
    };

    const correction = coordinator.installAuthorityAnchor(anchor, operation);

    expect(installAuthorityAnchor).toHaveBeenCalledWith(anchor, operation);
    expect(correction).toMatchObject({ nextScrollTop: 120, operation });
    expect(container.scrollTop).toBe(120);
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
