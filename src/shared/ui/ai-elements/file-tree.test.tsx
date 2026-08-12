import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileTree, FileTreeFolder } from "./file-tree";

function renderTree(density?: "default" | "compact") {
  const { container } = render(
    <FileTree density={density} defaultExpanded={new Set(["/root"])}>
      <FileTreeFolder path="/root" name="root">
        <FileTreeFolder path="/root/child" name="child" />
      </FileTreeFolder>
    </FileTree>,
  );

  expect(screen.getByText("child")).toBeInTheDocument();
  return container.querySelector('[data-slot="collapsible-content"] > div');
}

describe("FileTree density", () => {
  it("preserves the default hierarchy indentation", () => {
    expect(renderTree()).toHaveClass("ml-4", "pl-2");
  });

  it("supports compact hierarchy indentation", () => {
    expect(renderTree("compact")).toHaveClass("ml-2", "pl-1");
  });
});
