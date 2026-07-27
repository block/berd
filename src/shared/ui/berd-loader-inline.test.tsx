import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";

describe("BerdLoaderInline", () => {
  it("renders the spin animation when animated", () => {
    const { container } = render(<BerdLoaderInline animated />);

    expect(container.querySelector("animateTransform")).toBeInTheDocument();
  });

  it("renders no animation when static", () => {
    const { container } = render(<BerdLoaderInline animated={false} />);

    expect(container.querySelector("animateTransform")).not.toBeInTheDocument();
  });

  // SMIL silently disables the animation when keyTimes is not strictly
  // increasing (for example "0;1;1" from a SPIN_PORTION of 1 without the
  // continuous-spin branch). Guard the invariant so tuning the constants
  // cannot ship a frozen loader.
  it("keeps keyTimes strictly increasing so the spin cannot silently freeze", () => {
    const { container } = render(<BerdLoaderInline animated />);
    const animation = container.querySelector("animateTransform");

    const keyTimes = (animation?.getAttribute("keyTimes") ?? "")
      .split(";")
      .map(Number);
    const keySplines = animation?.getAttribute("keySplines") ?? "";

    expect(keyTimes.length).toBeGreaterThanOrEqual(2);
    expect(keyTimes[0]).toBe(0);
    expect(keyTimes.at(-1)).toBe(1);
    for (let i = 1; i < keyTimes.length; i += 1) {
      expect(keyTimes[i]).toBeGreaterThan(keyTimes[i - 1]);
    }
    // Spline calcMode requires exactly one spline per keyframe segment.
    expect(keySplines.split(";").length).toBe(keyTimes.length - 1);
  });

  it("is hidden from assistive tech when decorative", () => {
    const { container } = render(<BerdLoaderInline decorative />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("aria-label");
  });

  it("exposes a loading label when not decorative", () => {
    const { container } = render(<BerdLoaderInline />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "Loading");
  });
});
