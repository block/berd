import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LinkifiedText } from "./LinkifiedText";

describe("LinkifiedText preview boundaries", () => {
  it("keeps a complete URL clickable inside the boundary", () => {
    const text = "Visit https://example.com for details";
    const endOffset = text.indexOf(" for");

    render(<LinkifiedText text={text} endOffset={endOffset} />);

    expect(
      screen.getByRole("link", { name: "https://example.com" }),
    ).toHaveAttribute("href", "https://example.com");
  });

  it("renders a URL crossing the boundary as plain text", () => {
    const text = "Visit https://example.com/a/very/long/path";
    const endOffset = text.indexOf("/a/") + 4;

    render(<LinkifiedText text={text} endOffset={endOffset} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(text.slice(0, endOffset))).toBeInTheDocument();
  });
});
