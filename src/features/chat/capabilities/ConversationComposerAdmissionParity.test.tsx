import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationComposerBinding } from "./ConversationComposerCapability";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(() => true),
  sendDeferredAnyway: vi.fn(() => true),
  steerDraftMessage: vi.fn(() => true),
  steerQueuedMessage: vi.fn(() => true),
  securityPending: false,
}));

vi.mock("@/features/chat/hooks/useChatSessionController", () => ({
  useChatSessionController: () => ({
    handleSend: mocks.handleSend,
    sendDeferredAnyway: mocks.sendDeferredAnyway,
    steerDraftMessage: mocks.steerDraftMessage,
    steerQueuedMessage: mocks.steerQueuedMessage,
  }),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: (
    selector: (state: { sessions: ChatSession[] }) => unknown,
  ) => selector({ sessions: [] }),
}));

vi.mock("@/features/chat/stores/sessionWindowStore", () => ({
  useSessionWindowStore: (
    selector: (state: { isOpenInWindow: () => boolean }) => unknown,
  ) => selector({ isOpenInWindow: () => false }),
}));

vi.mock("@/features/security/stores/securityConfirmationStore", () => ({
  useSecurityConfirmationStore: (
    selector: (state: {
      pendingBySessionId: Record<string, unknown[]>;
    }) => unknown,
  ) =>
    selector({
      pendingBySessionId: mocks.securityPending ? { "session-1": [{}] } : {},
    }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "toolbar.agentBuilderPrepareFailed"
        ? "Agent preparation failed"
        : "Session creation failed",
  }),
}));

const ordinarySession = {
  id: "session-1",
  title: "Chat",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  messageCount: 1,
} satisfies ChatSession;

function useSurfaceBinding(
  surface: "chat" | "canvas",
  session: ChatSession,
  readOnlyReason?: string,
) {
  return useConversationComposerBinding({
    target: {
      kind: "existingSession",
      sessionId: session.id,
      sessionSnapshot: session,
      readOnlyReason,
      readOnlyWhenOpenInAnotherWindow: surface === "canvas",
    },
  });
}

describe("existing-session composer cross-surface parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.securityPending = false;
  });

  it.each([
    ["ordinary", ordinarySession, undefined, false],
    [
      "session creation failure",
      {
        ...ordinarySession,
        creationState: "failed" as const,
        creationError: "Creation failed",
      },
      undefined,
      true,
    ],
    [
      "execution target failure",
      {
        ...ordinarySession,
        intent: "build-agent" as const,
        targetAgentDraftState: "failed" as const,
      },
      undefined,
      true,
    ],
    ["read-only", ordinarySession, "Read only", true],
  ])("gives ChatView and canvas the same %s admission and ordinary/queue rejection", (_label, session, readOnlyReason, blocked) => {
    const chat = renderHook(() =>
      useSurfaceBinding("chat", session, readOnlyReason),
    ).result;
    const canvas = renderHook(() =>
      useSurfaceBinding("canvas", session, readOnlyReason),
    ).result;

    expect(canvas.current.admissionBlocked).toBe(chat.current.admissionBlocked);
    expect(canvas.current.admissionBlockingReason).toBe(
      chat.current.admissionBlockingReason,
    );
    expect(canvas.current.onSend("ordinary")).toBe(!blocked);
    expect(chat.current.onSend("ordinary")).toBe(!blocked);
    expect(canvas.current.onSendQueue).toBe(
      blocked ? undefined : mocks.sendDeferredAnyway,
    );
    expect(chat.current.onSendQueue).toBe(
      blocked ? undefined : mocks.sendDeferredAnyway,
    );
  });

  it("blocks ordinary, queue/deferred, MCP, and voice entry points while security confirmation is pending", () => {
    mocks.securityPending = true;
    const chat = renderHook(() => useSurfaceBinding("chat", ordinarySession))
      .result.current;
    const canvas = renderHook(() =>
      useSurfaceBinding("canvas", ordinarySession),
    ).result.current;

    for (const binding of [chat, canvas]) {
      expect(binding.target).toMatchObject({
        admission: {
          blocked: true,
          securityConfirmationPending: true,
        },
      });
      expect(binding.onSend("ordinary")).toBe(false);
      // MCP and voice consume this same admitted onSend handler in full chat;
      // canvas has neither extra path, so it cannot bypass the rejection.
      expect(binding.onSend("mcp")).toBe(false);
      expect(binding.onSend("voice")).toBe(false);
      expect(binding.onSendQueue).toBeUndefined();
    }
    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(mocks.sendDeferredAnyway).not.toHaveBeenCalled();
  });
});
