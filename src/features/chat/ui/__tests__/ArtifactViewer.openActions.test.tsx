import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { ArtifactPolicyProvider } from "../../hooks/ArtifactPolicyContext";
import { ArtifactViewer } from "../ArtifactViewer";
import { ArtifactsWidget } from "../widgets/ArtifactsWidget";

// End-to-end context wiring tests: unlike ArtifactViewer.test.tsx (which
// mocks useArtifactActionsContext), these render the REAL
// ArtifactPolicyProvider so a click on "Open in editor" must flow through the
// real context -> openResolvedPath -> pathExists -> the Tauri opener. The
// provider-scope regression that shipped in #178 (consumers silently getting
// the inert default context) is invisible to tests that mock the context;
// this file exists so the real wiring stays covered.

const mockOpenPath = vi.fn<(path: string) => Promise<void>>();
const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();
const mockReadTextFile = vi.fn();
const mockStatFile = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (path: string) => mockOpenPath(path),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    pathExists: (path: string) => mockPathExists(path),
    readTextFile: (path: string) => mockReadTextFile(path),
    statFile: (path: string) => mockStatFile(path),
  };
});

// jsdom has no Tauri internals, so the real asset-URL converter throws.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
}));

function messageWithArtifact(path: string): Message {
  return {
    id: "assistant-1",
    role: "assistant",
    created: 1,
    content: [
      {
        type: "toolRequest",
        id: "tool-1",
        name: "developer__text_editor",
        arguments: {},
        status: "success",
        locations: [{ path }],
      },
    ],
  } as unknown as Message;
}

function renderWithRealProvider(ui: React.ReactNode, path: string) {
  return render(
    <ArtifactPolicyProvider
      messages={[messageWithArtifact(path)]}
      sessionCwd="/p"
      sessionId="session-1"
    >
      {ui}
    </ArtifactPolicyProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  mockOpenPath.mockReset();
  mockOpenPath.mockResolvedValue(undefined);
  mockPathExists.mockReset();
  mockPathExists.mockResolvedValue(true);
  mockReadTextFile.mockReset();
  mockReadTextFile.mockResolvedValue({ contents: "# Title\n\nBody." });
  mockStatFile.mockReset();
  mockStatFile.mockResolvedValue({ byteSize: "20", modifiedAtNs: "1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArtifactViewer open actions through the real provider", () => {
  it("hands the file to the OS editor via the real context", async () => {
    const user = userEvent.setup();
    renderWithRealProvider(
      <ArtifactViewer
        artifact={{
          resolvedPath: "/p/report.md",
          filename: "report.md",
          revision: 0,
        }}
        onClose={vi.fn()}
      />,
      "/p/report.md",
    );

    await user.click(screen.getByRole("button", { name: /file actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /open in editor/i }));

    await vi.waitFor(() => {
      expect(mockOpenPath).toHaveBeenCalledWith("/p/report.md");
    });
  });
});

describe("ArtifactsWidget open actions through the real provider", () => {
  it("opens a non-viewable artifact externally via the real context", async () => {
    const user = userEvent.setup();
    renderWithRealProvider(
      <ArtifactsWidget isOpen onToggleOpen={vi.fn()} />,
      "/p/data.csv",
    );

    await user.click(screen.getByRole("button", { name: /data\.csv/i }));

    await vi.waitFor(() => {
      expect(mockOpenPath).toHaveBeenCalledWith("/p/data.csv");
    });
  });
});

describe("openResolvedPath failure handling", () => {
  it("does not let a failed hand-off consume the retry debounce", async () => {
    const user = userEvent.setup();
    mockOpenPath.mockRejectedValueOnce(new Error("forbidden path"));
    renderWithRealProvider(
      <ArtifactViewer
        artifact={{
          resolvedPath: "/p/report.md",
          filename: "report.md",
          revision: 0,
        }}
        onClose={vi.fn()}
      />,
      "/p/report.md",
    );

    await user.click(screen.getByRole("button", { name: /file actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /open in editor/i }));
    await vi.waitFor(() => {
      expect(mockOpenPath).toHaveBeenCalledTimes(1);
    });

    // Retry immediately: the failed attempt must not occupy the 1200ms
    // dedupe window, or the user's second click is silently absorbed.
    await user.click(screen.getByRole("button", { name: /file actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /open in editor/i }));
    await vi.waitFor(() => {
      expect(mockOpenPath).toHaveBeenCalledTimes(2);
    });
  });
});
