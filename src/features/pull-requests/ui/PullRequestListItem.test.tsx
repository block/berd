import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullRequestListItem } from "./PullRequestListItem";

describe("PullRequestListItem", () => {
  it("renders pull request identity and statuses and opens the item", () => {
    const onOpen = vi.fn();

    render(
      <PullRequestListItem
        repo="block/berd"
        number="#42"
        title="Share pull request rows"
        statuses={[
          { label: "Open", tone: "success" },
          { label: "Checks pending", tone: "warning" },
        ]}
        timestamp="Aug 19"
        ariaLabel="Open block/berd pull request #42 on GitHub"
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText("block/berd #42")).toBeVisible();
    expect(screen.getByText("Share pull request rows")).toBeVisible();
    expect(screen.getByText("Open")).toBeVisible();
    expect(screen.getByText("Checks pending")).toBeVisible();
    expect(screen.getByText("Aug 19")).toBeVisible();

    const item = screen.getByRole("button", {
      name: "Open block/berd pull request #42 on GitHub",
    });
    expect(item.className).toContain("bg-muted/60");
    expect(item.className).toContain("normal-case");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open block/berd pull request #42 on GitHub",
      }),
    );
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
