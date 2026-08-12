import { describe, expect, it, vi } from "vitest";
import { resetCardTilt, updateCardTilt } from "./cardTilt";

describe("cardTilt", () => {
  it("tilts toward the pointer and resets smoothly", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 100,
      height: 200,
    } as DOMRect);

    updateCardTilt(element, { clientX: 110, clientY: 20 });
    expect(element.style.transform).toBe("rotateX(8deg) rotateY(8deg)");
    expect(element.style.transition).toBe(
      "transform 110ms cubic-bezier(0.2, 0.7, 0.2, 1)",
    );

    resetCardTilt(element);
    expect(element.style.transform).toBe("none");
    expect(element.style.transition).toBe(
      "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)",
    );
  });

  it("does not tilt when reduced motion is preferred", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const element = document.createElement("div");

    updateCardTilt(element, { clientX: 1, clientY: 1 });

    expect(element.style.transform).toBe("");
  });
});
