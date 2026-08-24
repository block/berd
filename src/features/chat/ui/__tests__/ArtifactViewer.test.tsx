import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "../ArtifactViewer";

const mockOpenResolvedPath = vi.fn().mockResolvedValue(undefined);
const mockRevealInFileManager = vi.fn().mockResolvedValue(undefined);
const mockReadTextFile = vi.fn();
const mockStatFile = vi.fn();

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: () => null,
    pathExists: vi.fn().mockResolvedValue(true),
    openResolvedPath: mockOpenResolvedPath,
    openInApp: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: (path: string) => mockRevealInFileManager(path),
}));

vi.mock("@/shared/api/system", () => ({
  readTextFile: (path: string) => mockReadTextFile(path),
  statFile: (path: string) => mockStatFile(path),
}));

// jsdom has no Tauri internals, so the real asset-URL converter throws.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

function artifact(path = "/p/report.md") {
  return {
    resolvedPath: path,
    filename: path.split("/").pop() ?? path,
    revision: 0,
  };
}

async function openFileActionsMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /file actions/i }));
  return user;
}

describe("ArtifactViewer header actions", () => {
  beforeEach(() => {
    mockOpenResolvedPath.mockClear();
    mockRevealInFileManager.mockClear();
    mockReadTextFile.mockReset();
    mockReadTextFile.mockResolvedValue({ contents: "# Title\n\nBody copy." });
    mockStatFile.mockReset();
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals the file in the OS file manager from the file actions menu", async () => {
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);

    const user = await openFileActionsMenu();
    await user.click(screen.getByRole("menuitem", { name: /reveal in/i }));

    expect(mockRevealInFileManager).toHaveBeenCalledWith("/p/report.md");
    // Revealing must not also hand the file to an editor.
    expect(mockOpenResolvedPath).not.toHaveBeenCalled();
  });

  it("keeps opening the file in an editor from the same menu", async () => {
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);

    const user = await openFileActionsMenu();
    await user.click(screen.getByRole("menuitem", { name: /open in editor/i }));

    expect(mockOpenResolvedPath).toHaveBeenCalledWith("/p/report.md");
    expect(mockRevealInFileManager).not.toHaveBeenCalled();
  });

  it("offers both OS hand-offs for images too", async () => {
    render(
      <ArtifactViewer artifact={artifact("/p/shot.png")} onClose={vi.fn()} />,
    );

    await openFileActionsMenu();

    expect(
      screen.getByRole("menuitem", { name: /open in editor/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /reveal in/i }),
    ).toBeInTheDocument();
  });

  it("renders markdown headings at the app type scale, not Streamdown's", async () => {
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);

    const heading = await waitFor(() =>
      screen.getByRole("heading", { name: "Title" }),
    );
    // Assert the applied size, not just the absence of Streamdown's: a
    // negative-only assertion would also pass if headings rendered unstyled.
    // `text-lg` is the app's Title size (DESIGN.md §3); Streamdown ships
    // `text-3xl` here, so this fails if the components override regresses.
    expect(heading.className).toMatch(/\btext-lg\b/);
    expect(heading.className).not.toMatch(/text-(?:xl|2xl|3xl|4xl)/);
  });

  it("never uppercases heading text, so authored identifiers survive", async () => {
    // Heading text is authored document content, not app chrome. A `uppercase`
    // utility would silently rewrite casing that carries meaning (`api_KEY`,
    // filenames, paths), so no level may transform it.
    mockReadTextFile.mockResolvedValue({
      contents: "###### api_KEY and Path",
    });
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);

    const heading = await waitFor(() =>
      screen.getByRole("heading", { level: 6 }),
    );
    expect(heading.className).not.toMatch(/\buppercase\b/);
    expect(heading.textContent).toBe("api_KEY and Path");
  });

  it("polls the open file and swaps in externally changed text", async () => {
    vi.useFakeTimers();
    let changed = false;
    mockReadTextFile.mockImplementation(async () => ({
      contents: changed ? "# Updated externally" : "# Original",
    }));
    mockStatFile.mockImplementation(async () =>
      changed
        ? { byteSize: "20", modifiedAtNs: "2" }
        : { byteSize: "10", modifiedAtNs: "1" },
    );

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("heading", { name: "Original" }),
    ).toBeInTheDocument();

    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Updated externally" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
  });

  it("keeps last-good content visible and marks it stale when a changed file cannot be read", async () => {
    vi.useFakeTimers();
    let changed = false;
    mockReadTextFile.mockImplementation(async () => {
      if (changed) throw new Error("mid-write");
      return { contents: "# Last good copy" };
    });
    mockStatFile.mockImplementation(async () =>
      changed
        ? { byteSize: "20", modifiedAtNs: "2" }
        : { byteSize: "16", modifiedAtNs: "1" },
    );

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Last good copy" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();

    // A later unchanged stat must not silently clear the warning: the viewer
    // still has the old contents until a read succeeds.
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "2" });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);
  });
});
