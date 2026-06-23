import { describe, expect, it, vi } from "vitest";
import { readTranscriptElementBlockSize } from "./transcriptElementMeasurement";

function elementWithVisualHeight(height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      bottom: height,
      height,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) satisfies DOMRect;

  return element;
}

function mockComputedZoom(
  zoomByElement: ReadonlyMap<Element, string>,
): () => void {
  const originalGetComputedStyle = window.getComputedStyle;
  const spy = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element, pseudoElement) => {
      const style = originalGetComputedStyle(element, pseudoElement);
      return {
        ...style,
        getPropertyValue: (property: string) => {
          if (property === "zoom") {
            return zoomByElement.get(element) ?? "";
          }
          return style.getPropertyValue(property);
        },
      } as CSSStyleDeclaration;
    });

  return () => spy.mockRestore();
}

describe("readTranscriptElementBlockSize", () => {
  it("returns the visual block size when no css zoom is applied", () => {
    expect(readTranscriptElementBlockSize(elementWithVisualHeight(42.25))).toBe(
      43,
    );
  });

  it("normalizes measurements from an ancestor css zoom scope", () => {
    const zoomScope = document.createElement("div");
    const element = elementWithVisualHeight(70);
    const restoreComputedZoom = mockComputedZoom(new Map([[zoomScope, "0.7"]]));

    zoomScope.append(element);
    document.body.append(zoomScope);

    try {
      expect(readTranscriptElementBlockSize(element)).toBe(100);
    } finally {
      restoreComputedZoom();
      zoomScope.remove();
    }
  });

  it("normalizes percentage css zoom values", () => {
    const zoomScope = document.createElement("div");
    const element = elementWithVisualHeight(70);
    const restoreComputedZoom = mockComputedZoom(new Map([[zoomScope, "70%"]]));

    zoomScope.append(element);
    document.body.append(zoomScope);

    try {
      expect(readTranscriptElementBlockSize(element)).toBe(100);
    } finally {
      restoreComputedZoom();
      zoomScope.remove();
    }
  });

  it("normalizes nested css zoom scopes", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const element = elementWithVisualHeight(40);
    const restoreComputedZoom = mockComputedZoom(
      new Map([
        [outer, "0.8"],
        [inner, "0.5"],
      ]),
    );

    outer.append(inner);
    inner.append(element);
    document.body.append(outer);

    try {
      expect(readTranscriptElementBlockSize(element)).toBe(100);
    } finally {
      restoreComputedZoom();
      outer.remove();
    }
  });
});
