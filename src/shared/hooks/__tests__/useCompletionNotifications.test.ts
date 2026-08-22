import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
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
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";
import {
  ASSISTIVE_UX_STORAGE_KEY,
  ASSISTIVE_UX_RULES,
} from "@/shared/assistive-ux/registry";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getCurrentWindow: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
  getPlatform: vi.fn(),
  audioPlay: vi.fn(),
  toast: vi.fn(),
  toastCustom: vi.fn(),
  toastError: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
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
    window.localStorage.removeItem(ASSISTIVE_UX_STORAGE_KEY);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    mocks.invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "should_suppress_completion_notification"
          ? false
          : undefined,
      ),
    );
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.onAction.mockResolvedValue({ unregister: vi.fn() });
    mocks.audioPlay.mockResolvedValue(undefined);
    mocks.getPlatform.mockReturnValue("linux");
    vi.stubGlobal(
      "Audio",
      vi.fn(function MockAudio() {
        return { play: mocks.audioPlay };
      }),
    );
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
          sound: "berd-sounds-4.mp3",
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
    expect(mocks.audioPlay).toHaveBeenCalledTimes(1);
    const options = mocks.toast.mock.calls[0]?.[1] as {
      action?: unknown;
    };
    expect(isValidElement(options.action)).toBe(true);
    if (!isValidElement(options.action)) return;
    const action = options.action as React.ReactElement<{
      children: [
        React.ReactElement<{
          onClick?: () => void;
          children: React.ReactNode;
        }>,
        React.ReactElement<{
          onClick?: () => void;
          children: React.ReactNode;
        }>,
      ];
    }>;
    expect(action.type).toBe(ToastActionGroup);
    const [changeSoundAction, viewAction] = action.props.children;
    expect(changeSoundAction.type).toBe(ToastActionButton);
    expect(changeSoundAction.props.children).toBe("Change sound");
    expect(viewAction.type).toBe(ToastActionButton);
    expect(viewAction.props.children).toBe("View");
    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[ASSISTIVE_UX_RULES.notificationsChangeSound.id].shownCount,
    ).toBe(1);
    expect(mocks.toastCustom).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("suppresses notifications for the active voice session", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    mocks.invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "should_suppress_completion_notification"
          ? true
          : undefined,
      ),
    );
    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    renderHook(() => useCompletionNotifications(vi.fn()));
    await waitFor(() => expect(focusChanged).toBeTruthy());

    useChatStore
      .getState()
      .setMessages("voice-session", [makeMsg("completed")]);
    act(() => {
      focusChanged?.({ payload: true });
      useChatStore.getState().setChatState("voice-session", "streaming");
      useChatStore.getState().setChatState("voice-session", "idle");
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "should_suppress_completion_notification",
        { sessionId: "voice-session" },
      ),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.audioPlay).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "show_completion_notification",
      expect.anything(),
    );
  });

  it("does not notify after the completed session becomes actively viewed", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    const suppression = deferred<boolean>();
    mocks.invoke.mockImplementation((command: string) =>
      command === "should_suppress_completion_notification"
        ? suppression.promise
        : Promise.resolve(undefined),
    );
    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    renderHook(() => useCompletionNotifications(vi.fn()));
    await waitFor(() => expect(focusChanged).toBeTruthy());
    useChatStore
      .getState()
      .setMessages("session-focus", [makeMsg("completed")]);
    act(() => {
      focusChanged?.({ payload: false });
      useChatStore.getState().setChatState("session-focus", "streaming");
      useChatStore.getState().setChatState("session-focus", "idle");
    });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "should_suppress_completion_notification",
        { sessionId: "session-focus" },
      ),
    );

    act(() => {
      useChatStore.setState({
        activeSessionId: "session-focus",
        isViewingActiveSession: true,
      });
      focusChanged?.({ payload: true });
      suppression.resolve(false);
    });

    await Promise.resolve();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "show_completion_notification",
      expect.anything(),
    );
  });

  it("uses desktop delivery when the window backgrounds during suppression", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    const suppression = deferred<boolean>();
    mocks.invoke.mockImplementation((command: string) =>
      command === "should_suppress_completion_notification"
        ? suppression.promise
        : Promise.resolve(undefined),
    );
    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    renderHook(() => useCompletionNotifications(vi.fn()));
    await waitFor(() => expect(focusChanged).toBeTruthy());
    useChatStore
      .getState()
      .setMessages("session-background", [makeMsg("completed")]);
    act(() => {
      focusChanged?.({ payload: true });
      useChatStore.getState().setChatState("session-background", "streaming");
      useChatStore.getState().setChatState("session-background", "idle");
    });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "should_suppress_completion_notification",
        { sessionId: "session-background" },
      ),
    );

    act(() => {
      focusChanged?.({ payload: false });
      suppression.resolve(false);
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "show_completion_notification",
        expect.objectContaining({ sessionId: "session-background" }),
      ),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("opens notification settings and retires the discover moment from Change sound", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    const settingsEvents: CustomEvent[] = [];
    const onOpenSettings = (event: Event) => {
      settingsEvents.push(event as CustomEvent);
    };
    window.addEventListener("goose:open-settings", onOpenSettings);

    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    try {
      renderHook(() => useCompletionNotifications(vi.fn()));

      await waitFor(() => expect(focusChanged).toBeTruthy());

      useChatSessionStore.getState().addSession({
        id: "session-4",
        title: "Tune sound",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        messageCount: 1,
      });
      useChatStore.getState().setMessages("session-4", [makeMsg("completed")]);

      act(() => {
        focusChanged?.({ payload: true });
        useChatStore.getState().setChatState("session-4", "streaming");
        useChatStore.getState().setChatState("session-4", "idle");
      });

      await waitFor(() => expect(mocks.toast).toHaveBeenCalled());

      const options = mocks.toast.mock.calls[0]?.[1] as {
        action?: unknown;
      };
      expect(isValidElement(options.action)).toBe(true);
      if (!isValidElement(options.action)) return;

      const action = options.action as React.ReactElement<{
        children: [React.ReactElement<{ onClick?: () => void }>];
      }>;
      const [changeSoundAction] = action.props.children;
      act(() => {
        changeSoundAction.props.onClick?.();
      });

      expect(settingsEvents).toHaveLength(1);
      expect(settingsEvents[0]?.detail).toEqual({ section: "notifications" });
      expect(
        JSON.parse(
          window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
        ).moments[ASSISTIVE_UX_RULES.notificationsChangeSound.id].retiredReason,
      ).toBe("accepted");
    } finally {
      window.removeEventListener("goose:open-settings", onOpenSettings);
    }
  });

  it("does not process unrelated idle sessions for streaming text writes", async () => {
    const idleRuntime = { ...INITIAL_SESSION_CHAT_RUNTIME };
    Object.defineProperty(idleRuntime, "chatState", {
      get: () => {
        throw new Error("idle session was scanned");
      },
    });

    useChatStore.setState({
      activeSessionId: "idle",
      isViewingActiveSession: true,
      messagesBySession: {
        idle: [makeMsg("completed")],
        streaming: [
          {
            ...makeMsg("completed"),
            id: "streaming-message",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
      sessionStateById: {
        idle: idleRuntime,
        streaming: {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "streaming-message",
        },
      },
    });
    renderHook(() => useCompletionNotifications(vi.fn()));

    act(() => {
      useChatStore
        .getState()
        .appendStreamingText("streaming", "streaming-message", " world");
    });

    await Promise.resolve();
    expect(useChatStore.getState().sessionStateById.streaming.hasUnread).toBe(
      true,
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.audioPlay).not.toHaveBeenCalled();
  });

  it("passes null sound to desktop notifications when desktop sound is silent", async () => {
    let focusChanged: ((event: { payload: boolean }) => void) | null = null;
    window.localStorage.setItem(
      "goose:notifications",
      JSON.stringify({ desktopSound: "silent" }),
    );

    mocks.getCurrentWindow.mockReturnValue({
      onFocusChanged: vi.fn((handler) => {
        focusChanged = handler;
        return Promise.resolve(vi.fn());
      }),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    });

    renderHook(() => useCompletionNotifications(vi.fn()));

    await waitFor(() => expect(focusChanged).toBeTruthy());

    useChatSessionStore.getState().addSession({
      id: "session-3",
      title: "Quiet mode",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      messageCount: 1,
    });
    useChatStore.getState().setMessages("session-3", [makeMsg("completed")]);

    act(() => {
      focusChanged?.({ payload: false });
      useChatStore.getState().setChatState("session-3", "streaming");
      useChatStore.getState().setChatState("session-3", "idle");
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "show_completion_notification",
        {
          body: "Quiet mode finished",
          sessionId: "session-3",
          sound: null,
        },
      ),
    );
  });
});
