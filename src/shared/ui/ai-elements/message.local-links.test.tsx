import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

describe("MessageResponse local Markdown links", () => {
  it("preserves a bare relative filesystem path as a link", () => {
    render(
      <MessageResponse mode="static">
        {"Open the [research page](wiki/research/blockplat-compose.md)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "research page" })).toHaveAttribute(
      "href",
      "wiki/research/blockplat-compose.md",
    );
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it("preserves percent-encoded bare relative paths for artifact resolution", () => {
    render(
      <MessageResponse mode="static">
        {"Open the [research page](wiki/research/my%20report.md)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "research page" })).toHaveAttribute(
      "href",
      "wiki/research/my%20report.md",
    );
  });

  it("still blocks unsafe link schemes", () => {
    render(
      <MessageResponse mode="static">
        {"Do not open [this](javascript:alert(1))."}
      </MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "/__berd_local_path__/data%3Atext%2Fhtml%2Chello",
    "/__berd_local_path__/java%0Ascript%3Aalert(1)",
    "/__berd_local_path__/%00javascript%3Aalert(1)",
  ])("does not decode forged local-path sentinel %s", (forgedSentinel) => {
    render(
      <MessageResponse mode="static">
        {`Open [this](${forgedSentinel}).`}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "this" })).toHaveAttribute(
      "href",
      forgedSentinel,
    );
  });
});
