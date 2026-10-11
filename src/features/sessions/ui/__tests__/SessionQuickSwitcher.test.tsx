import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import { SessionQuickSwitcher } from "../SessionQuickSwitcher";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
afterEach(() => {
  if (originalScrollIntoView)
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useChatSessionStore.setState({
    sessions: [
      {
        id: "busy",
        title: "Working chat",
        createdAt: "2026-10-11T00:00:00Z",
        updatedAt: "2026-10-11T00:00:00Z",
        messageCount: 1,
      },
    ],
  });
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {
      busy: { ...INITIAL_SESSION_CHAT_RUNTIME, chatState: "thinking" },
    },
  });
});

describe("SessionQuickSwitcher activity", () => {
  it("keeps the compact status trailing and protects its primary color from command icon defaults", () => {
    render(
      <SessionQuickSwitcher
        open
        onOpenChange={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    const indicator = screen.getByRole("status");
    expect(indicator).toHaveClass("ml-auto");
    expect(indicator.querySelector("svg")).toHaveClass(
      "size-4",
      "text-primary",
    );
    expect(indicator).toHaveAccessibleName("Chat active");
  });
});
