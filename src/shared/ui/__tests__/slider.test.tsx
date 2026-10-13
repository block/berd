import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Slider } from "../slider";

describe("Slider", () => {
  it("forwards value/description ARIA to the thumb without leaking it to the root", () => {
    const { container } = render(
      <Slider
        value={[8]}
        min={3}
        max={60}
        aria-label="Duration"
        aria-valuetext="8 seconds"
        aria-describedby="help-text"
      />,
    );

    const root = container.querySelector('[data-slot="slider"]');
    const thumb = container.querySelector('[data-slot="slider-thumb"]');
    expect(thumb).toHaveAttribute("aria-valuetext", "8 seconds");
    expect(thumb).toHaveAttribute("aria-describedby", "help-text");
    expect(thumb).toHaveAttribute("aria-label", "Duration");
    // Value semantics are only valid on the slider role (the thumb); the
    // wrapper must not carry them.
    expect(root).not.toHaveAttribute("aria-valuetext");
    expect(root).not.toHaveAttribute("aria-describedby");
    expect(root).not.toHaveAttribute("aria-label");
  });
});
