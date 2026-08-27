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

// Keep the real `fileStatErrorKind` narrowing helper so these tests exercise
// the same "missing" vs "other" classification the app ships.
vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    readTextFile: (path: string) => mockReadTextFile(path),
    statFile: (path: string) => mockStatFile(path),
  };
});

// jsdom has no Tauri internals, so the real asset-URL converter throws.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
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
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

    // Two consecutive failed cycles: the first is inside the grace period.
    changed = true;
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });

    expect(
      screen.getByRole("heading", { name: "Last good copy" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();

    // A later unchanged stat must not silently clear the warning: the viewer
    // still has the old contents until a read succeeds.
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "2" });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);
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
    // A rendered decode failure is already visibly broken, so it flags
    // immediately with the unreadable copy — no grace period.
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);

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
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);

    fireEvent.load(refreshedImage);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("rejects a preloaded image whose fingerprint changed during decode and heals next cycle", async () => {
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

    // Torn write: the decoded bytes belong to no settled file version. The
    // rendered image is untouched and no warning appears — the view is not
    // wrong, only mid-transition.
    expect(renderedImage).toHaveAttribute(
      "src",
      "asset://localhost//p/shot.png?rev=4",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The next cycle sees a settled file and swaps the fresh image in.
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    await act(async () => {
      finishPreload?.();
      await flushAsyncWork();
    });
    const refreshedImage = screen.getByRole("img");
    expect(refreshedImage).toHaveAttribute(
      "src",
      "asset://localhost//p/shot.png?rev=5",
    );
    fireEvent.load(refreshedImage);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

describe("ArtifactViewer divergence grace period", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.useFakeTimers();
    mockReadTextFile.mockReset();
    mockReadTextFile.mockResolvedValue({ contents: "# Loaded fine" });
    mockStatFile.mockReset();
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function contentBody() {
    // The scroll container wrapping the markdown/raw/image body is what dims.
    return screen
      .getByRole("heading", { name: "Loaded fine" })
      .closest(".overflow-auto") as HTMLElement;
  }

  async function renderLoadedViewer() {
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(
      screen.getByRole("heading", { name: "Loaded fine" }),
    ).toBeInTheDocument();
  }

  async function advancePollCycle() {
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
  }

  it("keeps the view clean through a single transient stat failure", async () => {
    await renderLoadedViewer();

    mockStatFile.mockRejectedValueOnce({
      kind: "other",
      message: "transient I/O",
    });
    await advancePollCycle();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contentBody().className).not.toMatch(/\bopacity-60\b/);

    // The next cycle succeeds, so the streak resets and no warning ever shows.
    await advancePollCycle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contentBody().className).not.toMatch(/\bopacity-60\b/);
  });

  it("shows the warning strip and dims the body after two consecutive failures", async () => {
    await renderLoadedViewer();

    mockStatFile.mockRejectedValue({ kind: "other", message: "io error" });
    await advancePollCycle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await advancePollCycle();

    expect(screen.getByRole("status")).toHaveTextContent(
      "File changed but can't be read.",
    );
    expect(contentBody().className).toMatch(/\bopacity-60\b/);
  });

  it("treats a torn-write fingerprint mismatch as no verdict and heals next cycle", async () => {
    let phase: "settled" | "torn" | "updated" = "settled";
    let statCalls = 0;
    mockStatFile.mockImplementation(async () => {
      statCalls += 1;
      if (phase === "settled") return { byteSize: "20", modifiedAtNs: "1" };
      if (phase === "torn") {
        // The confirm stat (even call) disagrees with the cycle's first stat.
        return statCalls % 2 === 0
          ? { byteSize: "30", modifiedAtNs: "3" }
          : { byteSize: "25", modifiedAtNs: "2" };
      }
      return { byteSize: "30", modifiedAtNs: "3" };
    });
    mockReadTextFile.mockImplementation(async () => ({
      contents: phase === "settled" ? "# Loaded fine" : "# Settled rewrite",
    }));
    await renderLoadedViewer();

    phase = "torn";
    statCalls = 0;
    await advancePollCycle();
    // No flag, no strike consumed toward the threshold: torn reads carry no
    // information about whether the view is actually stale.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contentBody().className).not.toMatch(/\bopacity-60\b/);

    phase = "updated";
    await advancePollCycle();
    expect(
      screen.getByRole("heading", { name: "Settled rewrite" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a deleted file without offering a pointless reload", async () => {
    await renderLoadedViewer();

    mockStatFile.mockRejectedValue({
      kind: "missing",
      message: "no such file",
    });
    await advancePollCycle();
    await advancePollCycle();

    expect(screen.getByRole("status")).toHaveTextContent(
      "File deleted from disk.",
    );
    expect(
      screen.queryByRole("button", { name: /reload/i }),
    ).not.toBeInTheDocument();
    expect(contentBody().className).toMatch(/\bopacity-60\b/);
  });

  it("reports an unreadable file with a reload action", async () => {
    await renderLoadedViewer();

    mockStatFile.mockRejectedValue({ kind: "other", message: "EACCES" });
    await advancePollCycle();
    await advancePollCycle();

    expect(screen.getByRole("status")).toHaveTextContent(
      "File changed but can't be read.",
    );
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("flags a failed user-initiated reload immediately, bypassing the grace period", async () => {
    // Fail the initial load so the strip shows the "other" copy with a Reload
    // button while the strike counter sits at zero. A reload failure inside a
    // grace period would then be strike one of two and change nothing; the
    // bypass instead answers the user on the very first failure.
    mockStatFile.mockRejectedValueOnce({ kind: "other", message: "EACCES" });
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(screen.getByRole("status")).toHaveTextContent(
      "File changed but can't be read.",
    );

    // The user presses Reload; by now the file has been deleted outright.
    mockStatFile.mockRejectedValue({
      kind: "missing",
      message: "no such file",
    });
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await act(flushAsyncWork);

    // One failure, immediate verdict: the strip re-describes the divergence
    // as a deletion and drops the now-pointless Reload button.
    expect(screen.getByRole("status")).toHaveTextContent(
      "File deleted from disk.",
    );
    expect(
      screen.queryByRole("button", { name: /reload/i }),
    ).not.toBeInTheDocument();
  });

  it("clears the strip and dim on recovery and re-arms the full grace period", async () => {
    await renderLoadedViewer();

    mockStatFile.mockRejectedValue({ kind: "other", message: "io error" });
    await advancePollCycle();
    await advancePollCycle();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(contentBody().className).toMatch(/\bopacity-60\b/);

    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
    await advancePollCycle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contentBody().className).not.toMatch(/\bopacity-60\b/);

    // Strikes reset on recovery: a later single failure is back inside the
    // grace period rather than continuing the old streak.
    mockStatFile.mockRejectedValueOnce({ kind: "other", message: "blip" });
    await advancePollCycle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("ArtifactViewer presentation timeout", () => {
  // Mirrors PRESENTATION_TIMEOUT_MS in ArtifactViewer.tsx: the bound on any
  // single stat/read/decode step before it is treated as a failure.
  const PRESENTATION_TIMEOUT_MS = 10_000;

  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.useFakeTimers();
    mockReadTextFile.mockReset();
    mockReadTextFile.mockResolvedValue({ contents: "# Loaded fine" });
    mockStatFile.mockReset();
    mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function contentBody() {
    return screen
      .getByRole("heading", { name: "Loaded fine" })
      .closest(".overflow-auto") as HTMLElement;
  }

  async function renderLoadedViewer() {
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    expect(
      screen.getByRole("heading", { name: "Loaded fine" }),
    ).toBeInTheDocument();
  }

  // One poll cycle where the read hangs: the poll timer fires, stat resolves,
  // the read never settles, and the presentation timeout converts the hang
  // into an ordinary cycle failure.
  async function advanceHangingPollCycle() {
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
      vi.advanceTimersByTime(PRESENTATION_TIMEOUT_MS);
      await flushAsyncWork();
    });
  }

  it("times out a hung initial load into the error state and lets polling proceed", async () => {
    const hungStat = deferred<{ byteSize: string; modifiedAtNs: string }>();
    mockStatFile
      .mockReturnValueOnce(hungStat.promise)
      .mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} />);
    await act(flushAsyncWork);
    // Still hung: the loading spinner is up and nothing has been flagged yet.
    // (Query by strip copy — the spinner itself carries role="status".)
    expect(screen.queryByText(/can't be read/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/loading file/i)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(PRESENTATION_TIMEOUT_MS);
      await flushAsyncWork();
    });
    // No last-good content exists, so the timeout shows the error state and
    // flags immediately — same as any other initial-load failure.
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);

    // The timed-out forced refresh must have cleared its in-flight flag:
    // the next poll cycle runs, reads the now-healthy file, and heals.
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Loaded fine" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("gives hung reads the same two-strike grace period as failed reads", async () => {
    await renderLoadedViewer();

    // The file changed on disk, but every re-read hangs forever.
    const hungRead = deferred<{ contents: string }>();
    mockStatFile.mockResolvedValue({ byteSize: "21", modifiedAtNs: "2" });
    mockReadTextFile.mockReturnValue(hungRead.promise);

    await advanceHangingPollCycle();
    // First timed-out cycle is inside the grace period: last-good content
    // stays clean.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contentBody().className).not.toMatch(/\bopacity-60\b/);

    await advanceHangingPollCycle();
    // Second consecutive timeout: warning strip plus dimmed last-good body.
    expect(screen.getByRole("status")).toHaveTextContent(/can't be read/i);
    expect(contentBody().className).toMatch(/\bopacity-60\b/);
  });

  it("keeps polling after a timed-out cycle instead of wedging", async () => {
    await renderLoadedViewer();

    // One cycle hangs; the file itself has settled at a new version.
    const hungRead = deferred<{ contents: string }>();
    mockStatFile.mockResolvedValue({ byteSize: "21", modifiedAtNs: "2" });
    mockReadTextFile
      .mockReturnValueOnce(hungRead.promise)
      .mockResolvedValue({ contents: "# Fresh copy" });

    await advanceHangingPollCycle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // checkInFlight cleared and scheduleNextPoll ran: the very next cycle
    // reads the settled file and swaps the fresh contents in.
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Fresh copy" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores a late settlement of a timed-out read once newer content landed", async () => {
    await renderLoadedViewer();

    const hungRead = deferred<{ contents: string }>();
    mockStatFile.mockResolvedValue({ byteSize: "21", modifiedAtNs: "2" });
    mockReadTextFile
      .mockReturnValueOnce(hungRead.promise)
      .mockResolvedValue({ contents: "# Newer copy" });

    await advanceHangingPollCycle();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
    });
    expect(
      screen.getByRole("heading", { name: "Newer copy" }),
    ).toBeInTheDocument();

    // The hung read finally settles, long after its cycle was abandoned. The
    // timed-out wrapper already rejected, so these stale bytes must be inert.
    hungRead.resolve({ contents: "# Stale bytes" });
    await act(flushAsyncWork);

    expect(
      screen.getByRole("heading", { name: "Newer copy" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Stale bytes")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
