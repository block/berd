import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStartupDiagnosticIssue } from "../lib/startupDiagnostics";
import { StartupDiagnosticView } from "./StartupDiagnosticView";

vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: vi.fn().mockResolvedValue("/Users/test/Library/Logs/goose"),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("StartupDiagnosticView", () => {
  const writeText = vi.fn();

  function installClipboardMock() {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    installClipboardMock();
  });

  it("marks the backdrop as a window drag region", () => {
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    const { container } = render(
      <StartupDiagnosticView issue={issue} onRetry={vi.fn()} />,
    );

    expect(container.firstChild).toHaveAttribute("data-tauri-drag-region");
  });

  it("renders startup copy while keeping raw text in technical details", () => {
    const issue = buildStartupDiagnosticIssue(
      new Error("Failed to spawn goose serve: denied"),
    );

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Berd couldn't start" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The local Goose service didn't start. Try again, or copy the startup details and open the logs folder to share them with support.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === issue.rawError),
    ).toBeInTheDocument();
  });

  it("copies a diagnostic report", async () => {
    const user = userEvent.setup();
    installClipboardMock();
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy details" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("kind: unknown");
    expect(copied).toContain(issue.rawError);
    expect(copied).not.toContain("title key:");
    expect(copied).not.toContain("description key:");
    expect(
      screen.queryByRole("button", { name: "Copy raw error" }),
    ).not.toBeInTheDocument();
  });

  it("opens the app logs folder", async () => {
    const user = userEvent.setup();
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open logs folder" }));

    expect(openPath).toHaveBeenCalledWith("/Users/test/Library/Logs/goose");
  });

  it("retries startup when requested", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    render(<StartupDiagnosticView issue={issue} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders an emphasized steps list for WARP failures", () => {
    const issue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: true,
      status: 302,
      kind: "http_status",
      message: "kgoose probe to https://kgoose/ returned 302 Found",
    });

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    const list = screen.getByRole("list");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(list).toContainElement(items[0]);
    expect(items[0]).toHaveTextContent("Connect to WARP");
    expect(items[1]).toHaveTextContent("Click Retry");
  });

  it("omits the steps list for non-WARP failures", () => {
    const issue = buildStartupDiagnosticIssue(
      new Error("Failed to spawn goose serve: denied"),
    );

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect to WARP")).not.toBeInTheDocument();
  });

  it("renders the connectivity probe response in technical details whenever a probe was run", () => {
    const warpIssue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: true,
      status: 302,
      kind: "http_status",
      message: "kgoose probe to https://kgoose/ returned 302 Found",
    });

    const { unmount } = render(
      <StartupDiagnosticView issue={warpIssue} onRetry={vi.fn()} />,
    );

    expect(screen.getByText("Connectivity probe")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === warpIssue.connectivityProbe,
      ),
    ).toBeInTheDocument();
    unmount();

    const nonWarpIssue = buildStartupDiagnosticIssue(
      new Error("Invalid params"),
      {
        likelyWarpFailure: false,
        status: 404,
        kind: "http_status",
        message: "upstream 404",
      },
    );

    render(<StartupDiagnosticView issue={nonWarpIssue} onRetry={vi.fn()} />);

    expect(screen.getByText("Connectivity probe")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === nonWarpIssue.connectivityProbe,
      ),
    ).toBeInTheDocument();
  });

  it("omits the connectivity probe block when no probe report is attached", () => {
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    expect(screen.queryByText("Connectivity probe")).not.toBeInTheDocument();
  });
});
