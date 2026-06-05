import { act, renderHook, waitFor } from "@testing-library/react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCompletionOutcome,
  getNotificationBody,
  useCompletionNotifications,
} from "../useCompletionNotifications";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { ToastActionButton } from "@/shared/ui/sonner";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getCurrentWindow: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
  getPlatform: vi.fn(),
  toast: vi.fn(),
  toastCustom: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toast, {
    custom: (...args: unknown[]) => mocks.toastCustom(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks.getCurrentWindow(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: (...args: unknown[]) => mocks.sendNotification(...args),
  onAction: (...args: unknown[]) => mocks.onAction(...args),
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => mocks.getPlatform(),
}));

function resetStores() {
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });

  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isContextPanelOpen: false,
    activeWorkspaceBySession: {},
    modelSelectionIntentBySession: {},
  });
}

function makeMsg(completionStatus: string): Message {
  return {
    id: "m1",
    role: "assistant",
    created: Date.now(),
    content: [],
    metadata: {
      userVisible: true,
      agentVisible: true,
      completionStatus,
    } as Message["metadata"],
  };
}

// ── Pure function tests ────────────────────────────────────────────────────

describe("getCompletionOutcome", () => {
  it("returns 'error' when last assistant message has error status", () => {
    expect(getCompletionOutcome([makeMsg("error")])).toBe("error");
  });

  it("returns 'stopped' when last assistant message has stopped status", () => {
    expect(getCompletionOutcome([makeMsg("stopped")])).toBe("stopped");
  });

  it("returns 'completed' when last assistant message has completed status", () => {
    expect(getCompletionOutcome([makeMsg("completed")])).toBe("completed");
  });

  it("returns 'completed' as fallback for empty messages", () => {
    expect(getCompletionOutcome([])).toBe("completed");
  });

  it("uses the last assistant message when multiple exist", () => {
    expect(getCompletionOutcome([makeMsg("completed"), makeMsg("error")])).toBe(
      "error",
    );
  });
});

describe("getNotificationBody", () => {
  it("builds body for completed outcome", () => {
    expect(getNotificationBody("completed", "My session")).toBe(
      "My session finished",
    );
  });

  it("builds body for error outcome", () => {
    expect(getNotificationBody("error", "My session")).toBe(
      "My session encountered an error",
    );
  });

  it("builds body for stopped outcome", () => {
    expect(getNotificationBody("stopped", "My session")).toBe(
      "My session was stopped",
    );
  });

  it("falls back to 'Agent' when session title is empty", () => {
    expect(getNotificationBody("completed", "")).toBe("Agent finished");
  });
});

describe("useCompletionNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.localStorage.removeItem("goose:notifications");
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    mocks.invoke.mockResolvedValue(undefined);
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.onAction.mockResolvedValue({ unregister: vi.fn() });
    mocks.getPlatform.mockReturnValue("linux");
    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("does not register plugin action listeners on macOS desktop", async () => {
    mocks.getPlatform.mockReturnValue("mac");

    renderHook(() => useCompletionNotifications(vi.fn()));

    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith(
        "completion-notification-clicked",
        expect.any(Function),
      ),
    );
    expect(mocks.onAction).not.toHaveBeenCalled();
  });

  it("supports native desktop notification click-through", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    let notificationClicked:
      | ((event: { payload: { sessionId?: string } }) => void)
      | null = null;

    const appWindow = {
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getCurrentWindow.mockReturnValue(appWindow);
    mocks.listen.mockImplementation((event, handler) => {
      if (event === "completion-notification-clicked") {
        notificationClicked = handler;
      }
      return Promise.resolve(vi.fn());
    });

    const navigate = vi.fn();
    renderHook(() => useCompletionNotifications(navigate));

    await waitFor(() => expect(focusChanged).toBeTruthy());
    await waitFor(() => expect(notificationClicked).toBeTruthy());

    useChatSessionStore.getState().addSession({
      id: "session-1",
      title: "Review fixes",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      messageCount: 1,
    });
    useChatStore.getState().setMessages("session-1", [makeMsg("completed")]);

    act(() => {
      focusChanged?.({ payload: false });
      useChatStore.getState().setChatState("session-1", "streaming");
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "show_completion_notification",
        {
          body: "Review fixes finished",
          sessionId: "session-1",
          sound: "notification-complete.mp3",
        },
      ),
    );

    act(() => {
      notificationClicked?.({ payload: { sessionId: "session-1" } });
    });

    expect(navigate).toHaveBeenCalledWith("session-1");
    await waitFor(() => {
      expect(appWindow.show).toHaveBeenCalled();
      expect(appWindow.unminimize).toHaveBeenCalled();
      expect(appWindow.setFocus).toHaveBeenCalled();
    });
  });

  it("uses the shared Toaster-backed toast for in-app completion notifications", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;

    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    const navigate = vi.fn();
    renderHook(() => useCompletionNotifications(navigate));

    await waitFor(() => expect(focusChanged).toBeTruthy());

    useChatSessionStore.getState().addSession({
      id: "session-2",
      title: "Design polish",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      messageCount: 1,
    });
    useChatStore.getState().setMessages("session-2", [makeMsg("completed")]);

    act(() => {
      focusChanged?.({ payload: true });
      useChatStore.getState().setChatState("session-2", "streaming");
      useChatStore.getState().setChatState("session-2", "idle");
    });

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        "Design polish finished",
        expect.objectContaining({
          description: "Agent response complete",
        }),
      ),
    );
    const options = mocks.toast.mock.calls[0]?.[1] as {
      action?: unknown;
    };
    expect(isValidElement(options.action)).toBe(true);
    if (isValidElement(options.action)) {
      expect(options.action.type).toBe(ToastActionButton);
      expect(options.action.props).toEqual(
        expect.objectContaining({
          children: "View",
        }),
      );
    }
    expect(mocks.toastCustom).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
