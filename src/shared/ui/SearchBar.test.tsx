import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("hides the native clear control for pill-card search", () => {
    render(
      <SearchBar
        size="pill-card"
        value="query"
        onChange={() => undefined}
        aria-label="Search skills"
      />,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search skills" }),
    ).toHaveClass("[&::-webkit-search-cancel-button]:hidden");
  });

  it("keeps the native clear control for default search", () => {
    render(
      <SearchBar
        value="query"
        onChange={() => undefined}
        aria-label="Search projects"
      />,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search projects" }),
    ).not.toHaveClass("[&::-webkit-search-cancel-button]:hidden");
  });

  it("provides a visible focus-within treatment for pill-card search", async () => {
    const user = userEvent.setup();
    render(
      <SearchBar
        size="pill-card"
        value=""
        onChange={() => undefined}
        aria-label="Search skills"
      />,
    );

    const search = screen.getByRole("searchbox", { name: "Search skills" });
    await user.click(search);

    expect(search).toHaveFocus();
    expect(search.parentElement).toHaveClass(
      "ring-1",
      "ring-transparent",
      "focus-within:ring-ring",
    );
  });
});
