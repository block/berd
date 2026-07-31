import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationBuilderView } from "./AutomationBuilderView";

const mockUseAutomationBuilderSession = vi.fn();

vi.mock("@/features/automations/hooks/useAutomationBuilderSession", () => ({
  useAutomationBuilderSession: () => mockUseAutomationBuilderSession(),
}));

vi.mock("@/features/chat/ui/ChatInput", () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock("@/features/chat/ui/MessageTimeline", () => ({
  MessageTimeline: ({
    footer,
    placeholder,
  }: {
    footer: ReactNode;
    placeholder: ReactNode;
  }) => (
    <div>
      <div data-testid="timeline-placeholder">{placeholder}</div>
      <div>{footer}</div>
    </div>
  ),
}));

vi.mock("@/features/automations/ui/AutomationDraftRail", () => ({
  AutomationDraftRail: ({ className }: { className?: string }) => (
    <aside className={className} data-testid="draft-rail" />
  ),
}));

function builderSession() {
  return {
    sessionId: null,
    messages: [],
    status: "idle",
    isSubmitting: false,
    isStreaming: false,
    streamingMessageId: null,
    error: null,
    draftState: {
      draft: null,
      blockedToolRequest: null,
      createRequested: false,
      created: false,
      failed: false,
    },
    draftOverrides: {},
    hasUnsavedDraftChanges: false,
    setDraftOverride: vi.fn(),
    sendMessage: vi.fn(),
    approveDraft: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("AutomationBuilderView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseAutomationBuilderSession.mockReturnValue(builderSession());
  });

  it("resizes and resets the draft rail from its left edge", async () => {
    render(<AutomationBuilderView />);

    const separator = screen.getByTestId("automation-draft-rail-resize-handle");
    const railWrapper = separator.parentElement;
    expect(railWrapper).not.toBeNull();
    expect(railWrapper).toHaveStyle({
      "--automation-draft-rail-width": "337px",
    });

    fireEvent.mouseDown(separator, { clientX: 400 });
    fireEvent.mouseMove(document, { clientX: 340 });

    await waitFor(() => {
      expect(railWrapper).toHaveStyle({
        "--automation-draft-rail-width": "397px",
      });
    });

    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("goose:automation-builder:draft-rail") ??
            "0",
        ),
      ).toBe(397);
    });

    fireEvent.doubleClick(separator);

    await waitFor(() => {
      expect(railWrapper).toHaveStyle({
        "--automation-draft-rail-width": "337px",
      });
    });
  });

  it("keeps the default loading shimmer while streaming", () => {
    mockUseAutomationBuilderSession.mockReturnValue({
      ...builderSession(),
      isStreaming: true,
    });

    render(<AutomationBuilderView />);

    const shimmer = screen.getByRole("status").querySelector(".shimmer-text");
    expect(shimmer).toBeInTheDocument();
    expect(shimmer).not.toHaveClass("shimmer-text-continuous");
    expect(shimmer).toHaveStyle({
      "--bg":
        "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))",
    });
  });
});
