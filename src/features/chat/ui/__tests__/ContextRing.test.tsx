import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/shared/ui/button";
import { ContextRing } from "../ContextRing";

describe("ContextRing", () => {
  it("keeps its explicit rendered size inside buttons", () => {
    const { container } = render(
      <Button size="sm">
        <ContextRing tokens={25} limit={100} size={24} />
      </Button>,
    );

    const ring = container.querySelector("svg");

    expect(ring).toHaveAttribute("width", "24");
    expect(ring).toHaveAttribute("height", "24");
    expect(ring).toHaveClass(
      "h-[var(--context-ring-size)]",
      "w-[var(--context-ring-size)]",
    );
    expect(ring?.style.getPropertyValue("--context-ring-size")).toBe("24px");
    expect(container.querySelector("circle")).toHaveAttribute(
      "stroke",
      "var(--color-surface-composer-action)",
    );
  });
});
