import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { highlightKeywords } from "./highlightKeywords";

describe("literal message keyword highlights", () => {
  it("preserves original Unicode text after lowercase expansion", () => {
    const { container } = render(
      <p>{highlightKeywords("İ needle", "i needle")}</p>,
    );
    expect(container.textContent).toBe("İ needle");
    expect(
      Array.from(
        container.querySelectorAll("mark"),
        (mark) => mark.textContent,
      ),
    ).toEqual(["İ", "needle"]);
  });
  it("keeps punctuation literal and merges overlapping keywords", () => {
    const { container } = render(
      <p>{highlightKeywords("Search C++", "search arch C++")}</p>,
    );
    expect(
      Array.from(
        container.querySelectorAll("mark"),
        (mark) => mark.textContent,
      ),
    ).toEqual(["Search", "C++"]);
  });
});
