import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_BUILDER_RAIL_DEFAULT_FRACTION,
  useResizableAgentBuilderRail,
} from "@/features/chat/hooks/useResizableAgentBuilderRail";

const STORAGE_KEY = "goose:agent-builder-rail-fraction";
const MIN_FRACTION = 0.3;
const MAX_FRACTION = 0.72;

/**
 * The divider resolves the grid by attribute, so a drag needs a
 * grid > cell > divider chain where only the grid carries the marker.
 *
 * `cellRect` defaults to a deliberately *narrower* rect than the grid and is
 * installed on the intermediate cell. Measuring the cell instead of the grid
 * is the bug this shape exists to catch: a hop-counting implementation reads
 * the cell, so the assertions below would land on the wrong number.
 */
function mountDividerTree(
  gridRect: {
    left: number;
    right: number;
    width: number;
  },
  cellRect: { left: number; right: number; width: number } = {
    left: gridRect.right - gridRect.width * 0.3,
    right: gridRect.right,
    width: gridRect.width * 0.3,
  },
) {
  const grid = document.createElement("div");
  const cell = document.createElement("div");
  const divider = document.createElement("div");
  cell.appendChild(divider);
  grid.appendChild(cell);
  document.body.appendChild(grid);
  grid.setAttribute("data-agent-builder-grid", "");

  const rectFor =
    (rect: { left: number; right: number; width: number }) => () =>
      ({
        left: rect.left,
        right: rect.right,
        width: rect.width,
        top: 0,
        bottom: 100,
        height: 100,
        x: rect.left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

  grid.getBoundingClientRect = rectFor(gridRect);
  cell.getBoundingClientRect = rectFor(cellRect);

  return { grid, cell, divider };
}

function pointerDownOn(
  divider: HTMLElement,
  handler: (event: never) => void,
  button = 0,
) {
  handler({
    button,
    currentTarget: divider,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as never);
}

function dispatchPointer(type: string, clientX?: number) {
  window.dispatchEvent(
    new MouseEvent(type, clientX === undefined ? undefined : { clientX }),
  );
}

function keyDownEvent(key: string) {
  let defaultPrevented = false;
  return {
    event: {
      key,
      preventDefault: () => {
        defaultPrevented = true;
      },
    } as never,
    wasPrevented: () => defaultPrevented,
  };
}

describe("useResizableAgentBuilderRail", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("starts unresized so the split renders 50/50", () => {
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    expect(result.current.railFraction).toBeNull();
    expect(result.current.isResizingRail).toBe(false);
    expect(result.current.separatorProps["aria-valuenow"]).toBe(
      AGENT_BUILDER_RAIL_DEFAULT_FRACTION * 100,
    );
  });

  it("clamps a persisted fraction that is out of range", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(0.99));

    const { result } = renderHook(() => useResizableAgentBuilderRail());

    expect(result.current.railFraction).toBe(MAX_FRACTION);
  });

  it("falls back to the default split when the stored value is not a number", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("wide"));

    const { result } = renderHook(() => useResizableAgentBuilderRail());

    expect(result.current.railFraction).toBeNull();
  });

  it("maps pointer movement to a clamped builder fraction", () => {
    const { divider } = mountDividerTree({ left: 0, right: 1000, width: 1000 });
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown);
    });
    expect(result.current.isResizingRail).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");

    // Pointer at x=600 leaves 400px of a 1000px grid for the builder.
    act(() => {
      dispatchPointer("pointermove", 600);
    });
    expect(result.current.railFraction).toBeCloseTo(0.4);

    // Dragging past the floor clamps instead of collapsing the builder.
    act(() => {
      dispatchPointer("pointermove", 990);
    });
    expect(result.current.railFraction).toBe(MIN_FRACTION);

    act(() => {
      dispatchPointer("pointerup");
    });
    expect(result.current.isResizingRail).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  it("keeps a narrowed rail put when the drag is resumed", () => {
    // The reported bug: shrink the rail, release, then grab the divider again
    // and the rail jumps wider before the pointer has moved anywhere.
    //
    // The cell rect here is the narrow rail (300px of a 1000px grid). An
    // implementation that measures the cell instead of the grid computes
    // 250/300 = 0.83 -> clamped to the 0.72 maximum, i.e. the jump. Measuring
    // the grid yields 250/1000 = 0.25 -> clamped to the 0.3 minimum, so the
    // narrow rail stays narrow.
    const { divider } = mountDividerTree(
      { left: 0, right: 1000, width: 1000 },
      { left: 700, right: 1000, width: 300 },
    );
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown);
    });
    act(() => {
      dispatchPointer("pointermove", 750);
    });
    act(() => {
      dispatchPointer("pointerup");
    });
    expect(result.current.railFraction).toBe(MIN_FRACTION);

    // Resume the drag at the same place the pointer was released. The rail
    // must not grow just because the drag restarted.
    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown);
    });
    act(() => {
      dispatchPointer("pointermove", 750);
    });

    expect(result.current.railFraction).toBe(MIN_FRACTION);
    expect(result.current.railFraction).not.toBe(MAX_FRACTION);
  });

  it("ignores non-primary pointer buttons", () => {
    const { divider } = mountDividerTree({ left: 0, right: 1000, width: 1000 });
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown, 2);
    });

    expect(result.current.isResizingRail).toBe(false);
  });

  it("releases drag state when the pointer is cancelled", () => {
    const { divider } = mountDividerTree({ left: 0, right: 1000, width: 1000 });
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown);
    });
    act(() => {
      dispatchPointer("pointercancel");
    });

    expect(result.current.isResizingRail).toBe(false);
    expect(document.body.style.userSelect).toBe("");
  });

  it("stops tracking the pointer and restores the cursor after unmount", () => {
    const { divider } = mountDividerTree({ left: 0, right: 1000, width: 1000 });
    const { result, unmount } = renderHook(() =>
      useResizableAgentBuilderRail(),
    );

    act(() => {
      pointerDownOn(divider, result.current.separatorProps.onPointerDown);
    });
    act(() => {
      dispatchPointer("pointermove", 600);
    });
    const fractionBeforeUnmount = result.current.railFraction;

    unmount();

    // A stuck col-resize cursor (or a listener that keeps firing) is the bug
    // this guards; moving the pointer after unmount must be inert.
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    act(() => {
      dispatchPointer("pointermove", 400);
    });
    expect(result.current.railFraction).toBe(fractionBeforeUnmount);
  });

  it("resizes with the keyboard and clamps at both ends", () => {
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    // Builder sits on the right, so ArrowLeft grows it.
    const left = keyDownEvent("ArrowLeft");
    act(() => {
      result.current.separatorProps.onKeyDown(left.event);
    });
    expect(left.wasPrevented()).toBe(true);
    expect(result.current.railFraction).toBeCloseTo(
      AGENT_BUILDER_RAIL_DEFAULT_FRACTION + 0.02,
    );

    const right = keyDownEvent("ArrowRight");
    act(() => {
      result.current.separatorProps.onKeyDown(right.event);
    });
    expect(result.current.railFraction).toBeCloseTo(
      AGENT_BUILDER_RAIL_DEFAULT_FRACTION,
    );

    act(() => {
      result.current.separatorProps.onKeyDown(keyDownEvent("Home").event);
    });
    expect(result.current.railFraction).toBe(MAX_FRACTION);

    act(() => {
      result.current.separatorProps.onKeyDown(keyDownEvent("End").event);
    });
    expect(result.current.railFraction).toBe(MIN_FRACTION);
  });

  it("leaves the split alone for unrelated keys", () => {
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    const tab = keyDownEvent("Tab");
    act(() => {
      result.current.separatorProps.onKeyDown(tab.event);
    });

    expect(tab.wasPrevented()).toBe(false);
    expect(result.current.railFraction).toBeNull();
  });

  it("exposes the clamp range to assistive tech", () => {
    const { result } = renderHook(() => useResizableAgentBuilderRail());

    expect(result.current.separatorProps.role).toBe("separator");
    expect(result.current.separatorProps.tabIndex).toBe(0);
    expect(result.current.separatorProps["aria-orientation"]).toBe("vertical");
    expect(result.current.separatorProps["aria-valuemin"]).toBe(
      MIN_FRACTION * 100,
    );
    expect(result.current.separatorProps["aria-valuemax"]).toBe(
      MAX_FRACTION * 100,
    );
  });
});
