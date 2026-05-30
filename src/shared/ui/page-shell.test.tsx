import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageShell } from "./page-shell";

describe("PageShell", () => {
  it("anchors the bottom fade to the page viewport instead of the content column", () => {
    const { container } = render(
      <PageShell>
        <div data-testid="page-content">Page content</div>
      </PageShell>,
    );

    const content = screen.getByTestId("page-content");
    const contentGroup = content.parentElement;
    const contentColumn = contentGroup?.parentElement;
    const fade = container.querySelector("[aria-hidden='true']");

    expect(fade).toBeInstanceOf(HTMLElement);
    expect(fade).toHaveClass("absolute", "bottom-0", "h-36");
    expect(fade?.parentElement).not.toBe(contentGroup);
    expect(fade?.parentElement).not.toBe(contentColumn);
  });
});
