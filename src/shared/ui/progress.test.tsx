import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

describe("Progress", () => {
  it("exposes determinate values and preserves indeterminate semantics", () => {
    const view = render(<Progress aria-label="Download" value={42} />);

    expect(
      screen.getByRole("progressbar", { name: "Download" }),
    ).toHaveAttribute("aria-valuenow", "42");

    view.rerender(<Progress aria-label="Download" />);
    expect(
      screen.getByRole("progressbar", { name: "Download" }),
    ).not.toHaveAttribute("aria-valuenow");
  });
});
