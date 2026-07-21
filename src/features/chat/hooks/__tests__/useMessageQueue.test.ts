import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "@/shared/types/chat";
import { useChatStore } from "../../stores/chatStore";
import { useMessageQueue } from "../useMessageQueue";

describe("useMessageQueue", () => {
  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("starts with no queued message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    expect(result.current.queuedMessage).toBeNull();
  });

  it("enqueue stores a message in the Zustand store", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );

    act(() => result.current.enqueue("follow up"));

    expect(result.current.queuedMessage).toEqual({ text: "follow up" });
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "follow up",
    });
  });

  it("auto-sends queued message when chatState transitions to idle", () => {
    const sendMessage = vi.fn();
    // Start streaming with a queued message
    useChatStore.getState().enqueueMessage("s1", { text: "queued msg" });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    expect(sendMessage).not.toHaveBeenCalled();

    // Transition to idle
    rerender({ chatState: "idle" as const });

    expect(sendMessage).toHaveBeenCalledWith(
      "queued msg",
      undefined,
      undefined,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("does not auto-send when chatState is not idle", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s1", { text: "queued" });

    renderHook(() => useMessageQueue("s1", "streaming", sendMessage));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeDefined();
  });

  it("waits to auto-send while sending is blocked", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s1", { text: "queued" });

    const { rerender } = renderHook(
      ({ isSendBlocked }: { isSendBlocked: boolean }) =>
        useMessageQueue("s1", "idle", sendMessage, false, isSendBlocked),
      { initialProps: { isSendBlocked: true } },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "queued",
    });

    rerender({ isSendBlocked: false });

    expect(sendMessage).toHaveBeenCalledWith("queued", undefined, undefined);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("leaves berdctl-origin queued messages for the berdctl drain", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s1", {
      text: "queued from berdctl",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    rerender({ chatState: "idle" as const });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "queued from berdctl",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
  });

  it("dismiss clears the queued message without sending", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s1", { text: "queued" });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );

    act(() => result.current.dismiss());

    expect(result.current.queuedMessage).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queued messages are scoped to session", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s2", { text: "other session" });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    expect(result.current.queuedMessage).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("includes images when auto-sending", () => {
    const sendMessage = vi.fn();
    const attachments = [
      {
        id: "image-1",
        kind: "image" as const,
        name: "image.png",
        base64: "abc",
        mimeType: "image/png",
        previewUrl: "blob:image",
      },
    ];
    useChatStore.getState().enqueueMessage("s1", {
      text: "with image",
      attachments,
    });

    renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "with image",
      undefined,
      attachments,
    );
  });

  it("preserves personaId when auto-sending", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueMessage("s1", {
      text: "for persona A",
      personaId: "persona-a",
    });

    renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "for persona A",
      { id: "persona-a" },
      undefined,
    );
  });

  it("preserves tagged agents, skills, and attachments when auto-sending", () => {
    const sendMessage = vi.fn();
    const attachments = [
      {
        id: "file-1",
        kind: "file" as const,
        name: "notes.txt",
        path: "/tmp/notes.txt",
      },
    ];
    const sendOptions = {
      assistantPrompt: "Use these skills for this request: code-review.",
      displayText: "@Reviewer check this diff",
      chips: [
        {
          id: "reviewer",
          label: "Reviewer",
          agentRole: "active" as const,
          type: "agent" as const,
        },
        { label: "code-review", type: "skill" as const },
      ],
    };
    useChatStore.getState().enqueueMessage("s1", {
      text: "@Reviewer check this diff",
      personaId: "reviewer",
      attachments,
      sendOptions,
    });

    renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "@Reviewer check this diff",
      { id: "reviewer" },
      attachments,
      sendOptions,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("retries a queued message on the next idle transition after one failure", () => {
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    useChatStore.getState().enqueueMessage("s1", { text: "queued" });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "queued",
    });

    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("stops auto-retrying the same queued message after repeated failures", () => {
    const sendMessage = vi.fn().mockReturnValue(false);
    useChatStore.getState().enqueueMessage("s1", { text: "queued" });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });
    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "queued",
    });
  });

  it("drains queued message via store subscription when chatState transitions to idle (background-safe path)", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().enqueueMessage("s1", { text: "background msg" });

    // Set up the store with a non-idle chatState so the subscription can
    // detect the transition.
    useChatStore.getState().setChatState("s1", "streaming");

    // Mount the hook in a non-idle state so the drain effect doesn't fire
    // on initial render.
    renderHook(() => useMessageQueue("s1", "streaming", sendMessage));

    expect(sendMessage).not.toHaveBeenCalled();

    // Simulate the store transitioning to idle directly (as sendCore.ts does).
    // The store subscription fires synchronously and should call sendMessage
    // even without a React re-render — this is the background-safe path.
    act(() => {
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "background msg",
      undefined,
      undefined,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("reads live blocked state before draining via store subscription", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueMessage("s1", { text: "background msg" });
    chatStore.setChatState("s1", "streaming");
    chatStore.setActiveRunId("s1", "run-1");

    // Mount while the render-derived prop is blocked. In a backgrounded webview,
    // this prop may not update before the store transitions back to idle.
    renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage, false, true),
    );

    expect(sendMessage).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setActiveRunId("s1", null);
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "background msg",
      undefined,
      undefined,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("drains when a run clears after chatState is already idle", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueMessage("s1", { text: "background msg" });
    chatStore.setChatState("s1", "streaming");
    chatStore.setActiveRunId("s1", "run-1");

    renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage, false, true),
    );

    act(() => {
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setActiveRunId("s1", null);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "background msg",
      undefined,
      undefined,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("does not re-drain an async queued send while the first attempt is in flight", async () => {
    let resolveSend: (accepted: boolean) => void = () => {};
    const sendMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueMessage("s1", { text: "background msg" });
    chatStore.setChatState("s1", "streaming");

    renderHook(() => useMessageQueue("s1", "streaming", sendMessage));

    act(() => {
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "background msg",
    });

    // Auto-compaction can transition compacting -> idle before the original
    // send promise finalizes. The queue must not send the same prompt again.
    act(() => {
      useChatStore.getState().setChatState("s1", "compacting");
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend(true);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });
});
