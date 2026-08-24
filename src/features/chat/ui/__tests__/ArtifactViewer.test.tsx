import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function artifact(path = "/p/report.md", revision = 0) {
  return {
    resolvedPath: path,
    filename: path.split("/").pop() ?? path,
    revision,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function openFileActionsMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /file actions/i }));
  return user;
}

describe("ArtifactViewer header actions", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mockOpenResolvedPath.mockClear();
    mockRevealInFileManager.mockClear();
    mockReadTextFile.mockReset();
    mockReadTextFile.mockResolvedValue({ contents: "# Title\n\nBody copy." });
    mockStatFile.mockReset();
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("slows polling to ten seconds while the app is not foregrounded", async () => {
    vi.useFakeTimers();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    let changed = false;
    mockReadTextFile.mockImplementation(async () => ({
      contents: changed ? "# Background update" : "# Original",
    }));
    mockStatFile.mockImplementation(async () =>
      changed
        ? { byteSize: "20", modifiedAtNs: "2" }
        : { byteSize: "10", modifiedAtNs: "1" },
    );

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(
      screen.getByRole("heading", { name: "Original" }),
    ).toBeInTheDocument();

    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(9_999);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Original" }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Background update" }),
    ).toBeInTheDocument();
  });

  it("checks immediately on focus and restores foreground polling", async () => {
    vi.useFakeTimers();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    let version = 0;
    mockReadTextFile.mockImplementation(async () => ({
      contents: `# Version ${version}`,
    }));
    mockStatFile.mockImplementation(async () => ({
      byteSize: String(10 + version),
      modifiedAtNs: String(version),
    }));

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);

    version = 1;
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Version 1" }),
    ).toBeInTheDocument();

    version = 2;
    await act(async () => {
      vi.advanceTimersByTime(1_499);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Version 1" }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Version 2" }),
    ).toBeInTheDocument();
  });

  it("detects same-size same-mtime rewrites from change time", async () => {
    vi.useFakeTimers();
    let changed = false;
    mockReadTextFile.mockImplementation(async () => ({
      contents: changed ? "# Second" : "# First!",
    }));
    mockStatFile.mockImplementation(async () => ({
      byteSize: "8",
      modifiedAtNs: "1",
      changedAtNs: changed ? "2" : "1",
    }));

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(screen.getByRole("heading", { name: "First!" })).toBeInTheDocument();

    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });

    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
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

  it("recovers an initially failed empty text file to loaded state", async () => {
    vi.useFakeTimers();
    let available = false;
    mockReadTextFile.mockImplementation(async () => {
      if (!available) throw new Error("temporarily unavailable");
      return { contents: "" };
    });

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();

    available = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });

    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not let polling cancel an ACP-forced text reread", async () => {
    vi.useFakeTimers();
    const forcedRead = deferred<{ contents: string }>();
    mockReadTextFile
      .mockResolvedValueOnce({ contents: "# Original" })
      .mockReturnValueOnce(forcedRead.promise);

    const { rerender } = render(
      <ArtifactViewer artifact={artifact()} onClose={vi.fn()} />,
    );
    await act(flushAsyncWork);

    rerender(
      <ArtifactViewer artifact={artifact(undefined, 1)} onClose={vi.fn()} />,
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
    });
    forcedRead.resolve({ contents: "# Forced refresh" });
    await act(flushAsyncWork);

    expect(
      screen.getByRole("heading", { name: "Forced refresh" }),
    ).toBeInTheDocument();
  });

  it("commits image status only after the rendered cache-busted URL decodes", async () => {
    vi.useFakeTimers();
    const initialStat = deferred<{
      byteSize: string;
      modifiedAtNs: string;
    }>();
    mockStatFile
      .mockReturnValueOnce(initialStat.promise)
      .mockResolvedValue({ byteSize: "20", modifiedAtNs: "2" });
    const { rerender } = render(
      <ArtifactViewer
        artifact={artifact("/p/shot.png", 4)}
        onClose={vi.fn()}
      />,
    );

    const image = screen.getByRole("img");
    expect(image).toHaveAttribute("src", "asset://localhost//p/shot.png?rev=4");
    fireEvent.error(image);
    initialStat.resolve({ byteSize: "20", modifiedAtNs: "1" });
    await act(flushAsyncWork);
    // A late successful stat must not overwrite the earlier decode failure.
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);

    rerender(
      <ArtifactViewer
        artifact={artifact("/p/shot.png", 5)}
        onClose={vi.fn()}
      />,
    );
    await act(flushAsyncWork);
    const refreshedImage = screen.getByRole("img");
    expect(refreshedImage).toHaveAttribute(
      "src",
      "asset://localhost//p/shot.png?rev=5",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);

    fireEvent.load(refreshedImage);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("rejects a preloaded image when its fingerprint changes during decode", async () => {
    vi.useFakeTimers();
    let version = "1";
    mockStatFile.mockImplementation(async () => ({
      byteSize: "20",
      modifiedAtNs: version,
    }));
    let finishPreload: (() => void) | undefined;
    class PreloadImage {
      onload: (() => void) | null = null;

      set src(_value: string) {
        finishPreload = () => this.onload?.();
      }
    }
    vi.stubGlobal("Image", PreloadImage);

    render(
      <ArtifactViewer
        artifact={artifact("/p/shot.png", 4)}
        onClose={vi.fn()}
      />,
    );
    await act(flushAsyncWork);
    const renderedImage = screen.getByRole("img");
    fireEvent.load(renderedImage);

    version = "2";
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(finishPreload).toBeDefined();

    version = "3";
    await act(async () => {
      finishPreload?.();
      await flushAsyncWork();
    });

    expect(renderedImage).toHaveAttribute(
      "src",
      "asset://localhost//p/shot.png?rev=4",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);
  });

  it("preloads and renders the same image URL after a polled change", async () => {
    vi.useFakeTimers();
    let changed = false;
    mockStatFile.mockImplementation(async () => ({
      byteSize: "20",
      modifiedAtNs: changed ? "2" : "1",
    }));
    const preloadedSources: string[] = [];
    class PreloadImage {
      onload: (() => void) | null = null;

      set src(value: string) {
        preloadedSources.push(value);
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", PreloadImage);

    render(
      <ArtifactViewer
        artifact={artifact("/p/shot.png", 4)}
        onClose={vi.fn()}
      />,
    );
    await act(flushAsyncWork);
    fireEvent.load(screen.getByRole("img"));

    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });

    const expectedSrc = "asset://localhost//p/shot.png?rev=5";
    expect(preloadedSources).toEqual([expectedSrc]);
    expect(screen.getByRole("img")).toHaveAttribute("src", expectedSrc);

    fireEvent.load(screen.getByRole("img"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
