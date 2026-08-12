import { describe, expect, it } from "vitest";
import {
  consumeFreshWidgetPlacement,
  hasFreshWidgetPlacement,
  markFreshWidgetPlacement,
} from "./freshWidgetPlacements";

describe("freshWidgetPlacements", () => {
  it("reports a marked placement without consuming it", () => {
    markFreshWidgetPlacement("widget-a");

    // Pure read: StrictMode may run a useState initializer twice, so both
    // reads must see the entry.
    expect(hasFreshWidgetPlacement("widget-a")).toBe(true);
    expect(hasFreshWidgetPlacement("widget-a")).toBe(true);

    consumeFreshWidgetPlacement("widget-a");
  });

  it("does not report unmarked placements", () => {
    expect(hasFreshWidgetPlacement("never-marked")).toBe(false);
  });

  it("clears the entry once consumed", () => {
    markFreshWidgetPlacement("widget-b");
    consumeFreshWidgetPlacement("widget-b");

    expect(hasFreshWidgetPlacement("widget-b")).toBe(false);
  });

  it("tolerates consuming an entry that was never marked", () => {
    expect(() => consumeFreshWidgetPlacement("never-marked")).not.toThrow();
  });
});
