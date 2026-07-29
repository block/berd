import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactChips } from "../ArtifactChips";

const mockOpenInApp = vi.fn().mockResolvedValue(undefined);
const mockOpenResolvedPath = vi.fn().mockResolvedValue(undefined);

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: () => null,
    pathExists: vi.fn().mockResolvedValue(true),
    openResolvedPath: mockOpenResolvedPath,
    openInApp: mockOpenInApp,
  }),
}));

function target(path: string) {
  return { path, filename: path.split("/").pop() ?? path };
}

describe("ArtifactChips", () => {
  beforeEach(() => {
    mockOpenInApp.mockClear();
    mockOpenResolvedPath.mockClear();
  });

  it("renders nothing when there are no artifacts", () => {
    const { container } = render(<ArtifactChips artifacts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a chip per file", () => {
    render(
      <ArtifactChips artifacts={[target("/p/a.md"), target("/p/b.md")]} />,
    );
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });

  it("opens the file in the viewer when clicked", async () => {
    const user = userEvent.setup();
    render(<ArtifactChips artifacts={[target("/p/report.md")]} />);

    await user.click(screen.getByRole("button", { name: /open report\.md/i }));
    expect(mockOpenInApp).toHaveBeenCalledWith("/p/report.md", "report.md");
  });

  it("still offers a chip for files auto-open ignores (screenshots, machinery)", () => {
    // Manual re-entry is not gated by the auto-open importance policy: the
    // click is the intent.
    render(
      <ArtifactChips
        artifacts={[target("/p/shot.png"), target("/p/.agents/SKILL.md")]}
      />,
    );
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });

  it("collapses past the group threshold and expands on request", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactChips
        artifacts={[
          target("/p/a.md"),
          target("/p/b.md"),
          target("/p/c.md"),
          target("/p/d.md"),
          target("/p/e.md"),
        ]}
        groupThreshold={3}
      />,
    );

    // Only the first three render; the rest hide behind "+2 more".
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("c.md")).toBeInTheDocument();
    expect(screen.queryByText("d.md")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /\+2 more/i }));

    expect(screen.getByText("d.md")).toBeInTheDocument();
    expect(screen.getByText("e.md")).toBeInTheDocument();
  });

  it("does not collapse at exactly the threshold", () => {
    render(
      <ArtifactChips
        artifacts={[target("/p/a.md"), target("/p/b.md"), target("/p/c.md")]}
        groupThreshold={3}
      />,
    );
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
    expect(screen.getByText("c.md")).toBeInTheDocument();
  });
});
