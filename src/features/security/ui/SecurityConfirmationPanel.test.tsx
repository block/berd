import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import {
  type InferredExplanationState,
  type PendingSecurityConfirmation,
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { renderWithProviders } from "@/test/render";
import {
  SecurityConfirmationFallback,
  SecurityConfirmationPanel,
  useHasPendingSecurityConfirmation,
  useRegisterSecurityConfirmationSurface,
} from "./SecurityConfirmationPanel";

const command = 'python3 -c "import base64; exec(base64.b64decode(payload))"';

function SessionComposer({ sessionId }: { sessionId: string }) {
  const blocked = useHasPendingSecurityConfirmation(sessionId);
  return blocked ? null : <div>Composer {sessionId}</div>;
}

function RegisteredSurface({ sessionId }: { sessionId: string }) {
  useRegisterSecurityConfirmationSurface(sessionId);
  return null;
}

function makePending(
  sessionId: string,
  alertText: string,
  inferredExplanation: InferredExplanationState = { status: "idle" },
): PendingSecurityConfirmation {
  return {
    request: {
      sessionId,
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "block", kind: "reject_once" },
      ],
    } as never,
    title: "Execute shell command",
    command,
    alertText,
    resolve: vi.fn(),
    inferredExplanation,
  };
}

function renderPanel(
  alertText: string,
  inferredExplanation: InferredExplanationState = { status: "idle" },
) {
  const pending = makePending("session-1", alertText, inferredExplanation);
  useSecurityConfirmationStore.setState({
    pendingBySessionId: { "session-1": [pending] },
  });

  renderWithProviders(<SecurityConfirmationPanel sessionId="session-1" />);
  return { resolve: pending.resolve };
}

describe("SecurityConfirmationPanel", () => {
  beforeEach(() => {
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {},
      mountedSurfaceCountBySessionId: {},
    });
    useChatSessionStore.setState({ sessions: [] });
  });

  it("renders inline rather than opening a screen-blocking dialog", () => {
    renderPanel(
      [
        "🔒 Security Alert",
        "Confidence: 100%",
        "Security threat detected ()",
        "",
        "Command:",
        command,
        "Finding ID: SEC-validation",
      ].join("\n"),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const panel = screen.getByTestId("security-confirmation-panel");
    expect(panel).not.toHaveAttribute("role", "alert");
    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
    expect(panel).toHaveAccessibleName("Security alert");
    expect(panel).toHaveAccessibleDescription(
      "This action was flagged as a potential security risk. Review the details below before deciding whether to allow it.",
    );
    expect(
      screen.queryByText(/Security threat detected/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(command)).toHaveClass("max-w-full", "break-all");
    expect(screen.getByText("Finding ID: SEC-validation")).toHaveClass(
      "break-all",
    );
  });

  it("wraps an inferred explanation", () => {
    const explanation =
      "The encoded payload resembles an attempt to conceal executable instructions.";
    renderPanel("🔒 Security Alert\nConfidence: 87%", {
      status: "done",
      text: explanation,
    });

    expect(screen.getByText(explanation)).toHaveClass("break-words");
    expect(
      screen.getByText("Why this may have been flagged (inferred)"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  });

  it("shows an explicit fallback when inference fails", () => {
    renderPanel("🔒 Security Alert\nConfidence: 87%", { status: "failed" });

    expect(
      screen.getByText(
        "An explanation could not be generated. Review the command carefully before allowing it.",
      ),
    ).toBeInTheDocument();
  });

  it("offers Goose setup and safely blocks before opening provider settings", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);

    const first = makePending(
      "session-1",
      "🔒 Security Alert\nConfidence: 87%",
      { status: "needs_setup" },
    );
    const second = makePending(
      "session-1",
      "🔒 Security Alert\nConfidence: 92%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: { "session-1": [first, second] },
    });
    renderWithProviders(<SecurityConfirmationPanel sessionId="session-1" />);

    await user.click(screen.getByRole("button", { name: "Connect Goose" }));

    expect(first.resolve).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "block" },
    });
    expect(second.resolve).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "block" },
    });
    expect(useSecurityConfirmationStore.getState().pendingBySessionId).toEqual(
      {},
    );
    expect(openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { section: "providers" } }),
    );
    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  });

  it("replaces only the affected session composer and leaves navigation usable", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const pending = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: { "session-a": [pending] },
    });

    renderWithProviders(
      <>
        <button type="button" onClick={navigate}>
          Projects
        </button>
        <SessionComposer sessionId="session-a" />
        <SessionComposer sessionId="session-b" />
      </>,
    );

    expect(screen.queryByText("Composer session-a")).not.toBeInTheDocument();
    expect(screen.getByText("Composer session-b")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous session decisions isolated", async () => {
    const user = userEvent.setup();
    const first = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    const second = makePending(
      "session-b",
      "🔒 Security Alert\nConfidence: 92%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {
        "session-a": [first],
        "session-b": [second],
      },
    });

    renderWithProviders(
      <>
        <SecurityConfirmationPanel sessionId="session-a" />
        <SecurityConfirmationPanel sessionId="session-b" />
      </>,
    );

    const panels = screen.getAllByTestId("security-confirmation-panel");
    await user.click(within(panels[0]).getByRole("button", { name: "Block" }));

    expect(first.resolve).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "block" },
    });
    expect(second.resolve).not.toHaveBeenCalled();
    expect(useSecurityConfirmationStore.getState().pendingBySessionId).toEqual({
      "session-b": [second],
    });
  });

  it("ignores a stale decision after the next request reaches the queue head", () => {
    const first = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    const second = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 92%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: { "session-a": [first, second] },
    });

    const { resolveWith } = useSecurityConfirmationStore.getState();
    resolveWith("session-a", first.request, "allow-once");
    resolveWith("session-a", first.request, "allow-once");

    expect(first.resolve).toHaveBeenCalledOnce();
    expect(second.resolve).not.toHaveBeenCalled();
    expect(useSecurityConfirmationStore.getState().pendingBySessionId).toEqual({
      "session-a": [second],
    });
  });

  it("shows a nonblocking fallback when the affected chat is not mounted", async () => {
    const pending = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: { "session-a": [pending] },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-a",
          title: "Background review",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });

    const view = renderWithProviders(<SecurityConfirmationFallback />);
    expect(
      screen.getByTestId("security-confirmation-panel"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Security alert. This action was flagged as a potential security risk. Review the details below before deciding whether to allow it. From chat: Background review",
    );
    expect(
      screen.getByText("From chat: Background review"),
    ).toBeInTheDocument();

    view.rerender(
      <>
        <RegisteredSurface sessionId="session-a" />
        <SecurityConfirmationFallback />
      </>,
    );
    expect(
      screen.queryByTestId("security-confirmation-panel"),
    ).not.toBeInTheDocument();

    view.rerender(<SecurityConfirmationFallback />);
    await waitFor(() => {
      expect(
        screen.getByTestId("security-confirmation-panel"),
      ).toBeInTheDocument();
    });
  });

  it("does not overlay a background decision on an inline confirmation", () => {
    const background = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    const inline = makePending(
      "session-b",
      "🔒 Security Alert\nConfidence: 92%",
    );
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {
        "session-a": [background],
        "session-b": [inline],
      },
    });

    renderWithProviders(
      <>
        <RegisteredSurface sessionId="session-b" />
        <SecurityConfirmationFallback />
        <SecurityConfirmationPanel sessionId="session-b" />
      </>,
    );

    const panels = screen.getAllByTestId("security-confirmation-panel");
    expect(panels).toHaveLength(1);
    expect(within(panels[0]).getByText("92%")).toBeInTheDocument();
  });

  it("moves focus into the inline panel and restores the composer", async () => {
    const pending = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    renderWithProviders(
      <>
        <textarea aria-label="Message" />
        <SecurityConfirmationPanel sessionId="session-a" />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();

    act(() => {
      useSecurityConfirmationStore.setState({
        pendingBySessionId: { "session-a": [pending] },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("security-confirmation-panel")).toHaveFocus();
    });

    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("preserves the composer focus target across sequential requests", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const first = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 87%",
    );
    const second = makePending(
      "session-a",
      "🔒 Security Alert\nConfidence: 92%",
    );
    renderWithProviders(
      <>
        <textarea aria-label="Message" />
        <SecurityConfirmationPanel sessionId="session-a" />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();

    act(() => {
      useSecurityConfirmationStore.setState({
        pendingBySessionId: { "session-a": [first] },
      });
    });
    expect(screen.getByTestId("security-confirmation-panel")).toHaveFocus();

    act(() => {
      useSecurityConfirmationStore
        .getState()
        .resolveWith("session-a", first.request, "block");
    });
    act(() => {
      useSecurityConfirmationStore.setState({
        pendingBySessionId: { "session-a": [second] },
      });
    });
    act(() => {
      for (const frame of frames.splice(0)) {
        frame(performance.now());
      }
    });

    act(() => {
      useSecurityConfirmationStore
        .getState()
        .resolveWith("session-a", second.request, "block");
    });
    act(() => {
      for (const frame of frames.splice(0)) {
        frame(performance.now());
      }
    });

    expect(composer).toHaveFocus();
    requestAnimationFrame.mockRestore();
  });
});
