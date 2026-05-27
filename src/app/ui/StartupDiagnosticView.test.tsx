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

  it("renders startup copy while keeping raw text in technical details", () => {
    const issue = buildStartupDiagnosticIssue(
      new Error("Failed to spawn goose serve: denied"),
    );

    render(<StartupDiagnosticView issue={issue} onRetry={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Goose couldn't start" }),
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
});
