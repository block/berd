import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "@/shared/types/chat";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { QueuedMessageOwnershipLostError } from "../../lib/preCommitSendRejection";
import { beginModelSelectionIntent } from "../../model-selection/modelSelectionIntent";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "../../lib/sessionTargetCoordinator";
import type { ChatSendOptions } from "../../types";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { loadCachedMessageQueues } from "../../stores/queuePersistence";
import { useMessageQueue } from "../useMessageQueue";

const mocks = vi.hoisted(() => ({
  acpPrepareSession: vi.fn().mockResolvedValue(undefined),
  stopRealtimeForSession: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
}));

vi.mock("@/shared/api/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acp")>()),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock(
  "@/features/voice-conversation/hooks/useOpenAiRealtimeConversation",
  () => ({
    stopOpenAiRealtimeConversationForSession: (...args: unknown[]) =>
      mocks.stopRealtimeForSession(...args),
  }),
);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useMessageQueue", () => {
  beforeEach(() => {
    mocks.acpPrepareSession.mockClear();
    mocks.stopRealtimeForSession.mockClear();
    mocks.toastError.mockClear();
    window.localStorage.clear();
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s1",
          title: "Chat",
          executionTarget: { harnessId: "goose" },
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("admits under a pending draft id, then dispatches once after promotion", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          clientSessionId: "draft-session",
          title: "Chat",
          executionTarget: { harnessId: "goose" },
          creationState: "pending",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    const dispatch = vi.fn().mockReturnValue(true);
    const { result, rerender } = renderHook(
      ({ sessionId, ready }: { sessionId: string; ready: boolean }) =>
        useMessageQueue(
          sessionId,
          ready ? "idle" : "thinking",
          (text, persona, attachments, options) =>
            dispatch(sessionId, text, persona, attachments, options),
          false,
          false,
          ready,
        ),
      {
        initialProps: { sessionId: "draft-session", ready: false },
      },
    );

    act(() => {
      expect(result.current.enqueue("send when ready")).toBe(true);
    });

    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      payload: { text: "send when ready" },
    });
    expect(dispatch).not.toHaveBeenCalled();

    act(() => {
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["backend-session"]?.[0],
    ).toMatchObject({ payload: { text: "send when ready" } });

    rerender({ sessionId: "backend-session", ready: true });

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.slice(0, 2)).toEqual([
      "backend-session",
      "send when ready",
    ]);
    expect(
      useChatStore.getState().queuedMessageBySession["backend-session"],
    ).toBeUndefined();
  });

  it("drains an exact head once when its session gains a target", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s1", undefined);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "targetless head",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("s1", { harnessId: "goose" }),
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  it("drains an exact head once when a pinned placeholder hydrates with an ACP target", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatSessionStore.setState({ sessions: [] });
    useChatSessionStore.getState().ensurePinnedSessionPlaceholder("s1");
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "pinned targetless head",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore
        .getState()
        .patchSession("s1", { pinnedLoadState: undefined }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === "s1"
            ? {
                ...session,
                executionTarget: { harnessId: "goose" },
                executionTargetSource: "acp" as const,
              }
            : session,
        ),
      })),
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  it("ignores unrelated session updates while an exact head stays targetless", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s1", undefined);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "targetless head",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    act(() =>
      useChatSessionStore.getState().patchSession("s1", { title: "Renamed" }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("drains exactly once when a direct Berdctl lease releases without another state change", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const berdctlLease = acquireSessionDispatchTarget("s1");
    expect(berdctlLease).not.toBeNull();
    expect(acquireSessionDispatchTarget("s1")).toMatchObject({
      status: "contended",
    });

    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "dispatch after Berdctl settles",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    expect(result.current.queuedMessage?.text).toBe(
      "dispatch after Berdctl settles",
    );
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => berdctlLease.release?.());

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith(
      "dispatch after Berdctl settles",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("dispatches the current replacement after a blocked head changes", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const berdctlLease = acquireSessionDispatchTarget("s1");
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => berdctlLease.release?.());

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith(
      "replacement",
      undefined,
      undefined,
      expect.any(Object),
    );
  });

  it("removes a blocked release retry when its owner unmounts", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const berdctlLease = acquireSessionDispatchTarget("s1");
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "leave queued",
    });
    const owner = renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    owner.unmount();
    act(() => berdctlLease.release?.());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("leave queued");
  });

  it("holds the dispatch target through queued compaction and send settlement", async () => {
    const initialTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    };
    const updatedTarget = {
      harnessId: "goose" as const,
      modelProviderId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    };
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s1", initialTarget);
    const compaction = deferred<void>();
    const observedTargets: unknown[] = [];
    const sendMessage = vi.fn(
      async (
        _text: string,
        _persona: unknown,
        _attachments: unknown,
        options?: ChatSendOptions,
      ) => {
        observedTargets.push(options?.sessionSelection);
        await compaction.promise;
        observedTargets.push(options?.sessionSelection);
        options?.beforeUserMessageCommitted?.();
        options?.onUserMessageCommitted?.();
        return true;
      },
    );
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    act(() => expect(result.current.enqueue("compact then send")).toBe(true));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const requestId = "selection-during-compaction";
    beginModelSelectionIntent("s1", {
      requestId,
      target: updatedTarget,
      previousTarget: initialTarget,
    });
    const applySelection = transitionSessionTarget({
      sessionId: "s1",
      target: updatedTarget,
      workingDir: "/tmp/project",
      requestId,
    });
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(initialTarget);

    await act(async () => {
      compaction.resolve();
      await compaction.promise;
    });
    await applySelection;
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(updatedTarget);
    expect(observedTargets).toEqual([initialTarget, initialTarget]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("releases a deferred target after queued compaction fails", async () => {
    const initialTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    };
    const updatedTarget = {
      harnessId: "goose" as const,
      modelProviderId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    };
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s1", initialTarget);
    const compaction = deferred<void>();
    const sendMessage = vi.fn(async () => {
      await compaction.promise;
      return false;
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    act(() => expect(result.current.enqueue("failed compaction")).toBe(true));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const requestId = "selection-during-failed-compaction";
    beginModelSelectionIntent("s1", {
      requestId,
      target: updatedTarget,
      previousTarget: initialTarget,
    });
    const applySelection = transitionSessionTarget({
      sessionId: "s1",
      target: updatedTarget,
      workingDir: "/tmp/project",
      requestId,
    });
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(initialTarget);

    await act(async () => {
      compaction.resolve();
      await compaction.promise;
    });
    await applySelection;
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(updatedTarget);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toHaveLength(1);
  });

  it("pauses an edited head across an idle transition, then sends the update", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().setChatState("s1", "streaming");
    const { result, rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "stale",
      });
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";
    act(() => expect(result.current.beginEditing(recordId)).toBe(true));

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    rerender({ chatState: "idle" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({ recordId, editing: true });

    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "updated",
        }),
      ).toBe(true),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      "updated",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("does not drain an edited record until preparation and live runtime are both ready", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().setChatState("s1", "idle");
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const { result, rerender } = renderHook(
      ({ preparationReady }: { preparationReady: boolean }) =>
        useMessageQueue(
          "s1",
          preparationReady ? "idle" : "thinking",
          sendMessage,
          false,
          false,
          preparationReady,
        ),
      { initialProps: { preparationReady: false } },
    );
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );

    expect(sendMessage).not.toHaveBeenCalled();

    rerender({ preparationReady: true });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith(
      "replacement",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("rejects commit after the in-flight queued payload is edited", async () => {
    let commitQueuedMessage!: () => void;
    let resolveSend!: (accepted: boolean) => void;
    const sendMessage = vi.fn(
      (
        _text: string,
        _persona: unknown,
        _attachments: unknown,
        options?: { beforeUserMessageCommitted?: () => void },
      ) => {
        commitQueuedMessage = options?.beforeUserMessageCommitted ?? (() => {});
        return new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        });
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );

    expect(commitQueuedMessage).toThrowError(
      new QueuedMessageOwnershipLostError(),
    );
    act(() => resolveSend(false));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(
      "replacement",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("replacement");
  });

  it("waits for live readiness before retrying an edited stale head", async () => {
    let resolveOriginal!: (accepted: boolean) => void;
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveOriginal = resolve;
          }),
      )
      .mockReturnValueOnce(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );
    act(() => useChatStore.getState().setActiveRunId("s1", "run-1"));
    await act(async () => resolveOriginal(false));

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("replacement");

    act(() => useChatStore.getState().setActiveRunId("s1", null));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(
      "replacement",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("retains an edited record when its original async send settles", async () => {
    let resolveSend: ((accepted: boolean) => void) | undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    useChatStore.getState().setChatState("s1", "streaming");
    const { result, rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );
    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "original",
      });
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    rerender({ chatState: "idle" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );
    await act(async () => resolveSend?.(true));

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      recordId,
      payload: {
        persona: { kind: "inherit" },
        text: "replacement",
      },
    });
  });

  it("drains multiple queued messages in FIFO order as each send settles", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().setChatState("s1", "streaming");
    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    act(() => {
      const store = useChatStore.getState();
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "first",
      });
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "second",
      });
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "third",
      });
    });

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    rerender({ chatState: "idle" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    expect(sendMessage.mock.calls.map(([text]) => text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("waits for restored queue replay readiness before draining", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.setState({
      queuedMessageBySession: {
        s1: [
          {
            kind: "transport-ready",
            recordId: "restored-record",
            payload: {
              persona: { kind: "inherit" },
              text: "restored",
            },
            restored: true,
          },
        ],
      },
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => useChatStore.getState().markQueuedMessagesReady("s1"));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      "restored",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("starts with no queued message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    expect(result.current.queuedMessage).toBeNull();
  });

  it("enqueue stores a message in the Zustand store while the runtime is busy", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().setChatState("s1", "streaming");
    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );

    act(() =>
      result.current.enqueue(
        "follow up",
        undefined,
        undefined,
        undefined,
        undefined,
        { harnessId: "goose" },
      ),
    );

    expect(result.current.queuedMessage).toMatchObject({ text: "follow up" });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "follow up",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not drain a newly enqueued transport-ready message from the store subscription while rendered readiness is blocked", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    renderHook(() => useMessageQueue("s1", "thinking", sendMessage));

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "not ready yet",
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "not ready yet",
    });
  });

  it("leaves a released deferred record for the app-level background drain", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const record = useChatStore.getState().enqueueDeferredMessage(
      "s1",
      { persona: { kind: "inherit" }, text: "prepared first message" },
      {
        type: "workspace-first-send",
        status: "creating",
        projectId: "project-1",
        desired: [],
      },
    );
    expect(record).not.toBeNull();

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => {
      useChatStore
        .getState()
        .releaseDeferredMessage("s1", record?.recordId ?? "missing");
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record?.recordId,
      releasedFromDeferred: true,
    });
  });

  it("does not expose or drain deferred records", () => {
    const sendMessage = vi.fn();
    useChatStore.setState({
      queuedMessageBySession: {
        s1: [
          {
            kind: "deferred",
            recordId: "deferred-1",
            payload: { persona: { kind: "inherit" }, text: "held" },
            state: { phase: "failed" },
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    expect(result.current.queuedMessage).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId,
    ).toBe("deferred-1");
  });

  it("auto-sends queued message when chatState transitions to idle", () => {
    const sendMessage = vi.fn();
    // Start streaming with a queued message
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued msg",
    });

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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("does not auto-send when chatState is not idle", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "streaming", sendMessage));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeDefined();
  });

  it("waits to auto-send while sending is blocked", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { rerender } = renderHook(
      ({ isSendBlocked }: { isSendBlocked: boolean }) =>
        useMessageQueue("s1", "idle", sendMessage, false, isSendBlocked),
      { initialProps: { isSendBlocked: true } },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "queued",
    });

    rerender({ isSendBlocked: false });

    expect(sendMessage).toHaveBeenCalledWith(
      "queued",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("leaves berdctl-origin queued messages for the berdctl drain", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
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
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "queued from berdctl",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
  });

  it("dismiss clears the queued message without sending", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );

    act(() => result.current.dismiss());

    expect(result.current.queuedMessage).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send the next queued message when the head is dismissed", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "first",
    });
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "second",
    });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage, false, true),
    );

    act(() => result.current.dismiss(result.current.queuedRecord?.recordId));

    expect(result.current.queuedMessage?.text).toBe("second");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queued messages are scoped to session", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s2", {
      persona: { kind: "inherit" },
      text: "other session",
    });

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
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("stores persona intent without capturing the session target", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s1",
          title: "Chat",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose-gpt-5-6-sol",
            modelName: "GPT-5.6 Sol",
          },
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", vi.fn()),
    );

    act(() => {
      result.current.enqueue("keep this model", "persona-a");
    });

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      payload: {
        text: "keep this model",
        persona: { kind: "persona", id: "persona-a" },
      },
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).not.toHaveProperty("executionTarget");
  });

  it("preserves personaId when auto-sending", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "persona", id: "persona-a" },
      text: "for persona A",
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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
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
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "persona", id: "reviewer" },
      text: "@Reviewer check this diff",
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
      expect.objectContaining({
        ...sendOptions,
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("retains the exact queued head after a pre-commit rejection", async () => {
    let rejectBeforeCommit!: (accepted: boolean) => void;
    const sendMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          rejectBeforeCommit = resolve;
        }),
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
      sendOptions: { executionSystemPrompt: "captured prompt" },
    });
    const queuedHead = useChatStore.getState().queuedMessageBySession.s1?.[0];

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    act(() => rejectBeforeCommit(false));
    await waitFor(() =>
      expect(useChatStore.getState().queuedMessageBySession.s1?.[0]).toBe(
        queuedHead,
      ),
    );
  });

  it("retains and retries when readiness changes before commit", async () => {
    const sendMessage = vi.fn(
      (
        _text: string,
        _persona?: { id: string | null; name?: string },
        _attachments?: ChatAttachmentDraft[],
        options?: ChatSendOptions,
      ) => {
        useChatStore.getState().setActiveRunId("s1", "racing-run");
        expect(() => options?.beforeUserMessageCommitted?.()).toThrow();
        return Promise.resolve(false);
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });
    const queuedHead = useChatStore.getState().queuedMessageBySession.s1?.[0];

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(useChatStore.getState().queuedMessageBySession.s1?.[0]).toBe(
      queuedHead,
    );

    sendMessage.mockImplementationOnce(() => Promise.resolve(true));
    act(() => useChatStore.getState().setActiveRunId("s1", null));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("does not retry after the queued user turn commits", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(
      (
        _text: string,
        _persona?: { id: string | null; name?: string },
        _attachments?: ChatAttachmentDraft[],
        options?: ChatSendOptions,
      ) => {
        options?.beforeUserMessageCommitted?.();
        options?.onUserMessageCommitted?.();
        return Promise.reject(new Error("transport failed after commit"));
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("retries an edited failed head immediately while still idle", async () => {
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "invalid",
    });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";
    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "corrected",
        }),
      ).toBe(true),
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(
      "corrected",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("keeps retrying a retained pre-commit failure with backoff while the session stays ready", async () => {
    // LAWS/CHAT.md: the queue must resume sending when the session is ready.
    // Pre-commit rejections are silent and leave no store transition behind,
    // so abandoning the record after a fixed retry count strands it forever.
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());
    expect(sendMessage).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(4);

    sendMessage.mockResolvedValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("stops automatic retries for a persistently rejected payload despite readiness churn", async () => {
    // A failed auto-compaction returns false, appends an error notification,
    // and sets the session back to idle. That idle edge re-triggers the drain,
    // so without a ceiling the send loops as fast as compaction can fail and
    // grows the transcript every pass.
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());

    for (let pass = 0; pass < 12; pass += 1) {
      await act(async () => {
        useChatStore.getState().setChatState("s1", "compacting");
        useChatStore.getState().setChatState("s1", "idle");
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({ text: "queued" });
    vi.useRealTimers();
  });

  it("backs off the readiness wait instead of re-arming every second", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useMessageQueue(
          "s1",
          ready ? "idle" : "thinking",
          sendMessage,
          false,
          false,
          ready,
        ),
      { initialProps: { ready: true } },
    );
    await act(async () => Promise.resolve());
    expect(sendMessage).toHaveBeenCalledOnce();

    // Capture re-arm delays only; installing this earlier would intercept the
    // scheduling that produces the first attempt.
    const delays: number[] = [];
    const fakeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: Parameters<typeof fakeSetTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === "number" && ms >= 1_000) delays.push(ms);
      return (
        fakeSetTimeout as unknown as (
          ...args: unknown[]
        ) => ReturnType<typeof fakeSetTimeout>
      )(fn, ms, ...rest);
    }) as unknown as typeof globalThis.setTimeout;

    try {
      rerender({ ready: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
    } finally {
      globalThis.setTimeout = fakeSetTimeout;
    }

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(delays.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(Math.max(...delays)).toBe(30_000);
    // Flat one-second re-arming would be 600 wakeups over the same window.
    expect(delays.length).toBeLessThan(40);
    vi.useRealTimers();
  });

  it("waits for preparation readiness before a timed retry", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { rerender } = renderHook(
      ({ preparationReady }: { preparationReady: boolean }) =>
        useMessageQueue(
          "s1",
          preparationReady ? "idle" : "thinking",
          sendMessage,
          false,
          false,
          preparationReady,
        ),
      { initialProps: { preparationReady: true } },
    );
    await act(async () => Promise.resolve());
    expect(sendMessage).toHaveBeenCalledOnce();

    rerender({ preparationReady: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    rerender({ preparationReady: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({ text: "queued" });
    vi.useRealTimers();
  });

  it("retries a queued message on the next idle transition after one failure", () => {
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "queued",
    });

    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("reveals and retries a hidden startup handoff if its send fails", async () => {
    vi.useFakeTimers();
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "first message",
      showInComposer: false,
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "first message",
      showInComposer: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("keeps transport-only voice coordination hidden while queued", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );

    act(() => {
      expect(
        result.current.enqueue(
          "[Handoff handoff-3 from spokesperson; cursor 3] Check the result",
          undefined,
          undefined,
          {
            userMessageMetadata: {
              origin: "voice_conversation",
              userVisible: false,
            },
          },
        ),
      ).toBe(true);
    });

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      showInComposer: false,
      sendOptions: {
        userMessageMetadata: {
          origin: "voice_conversation",
          userVisible: false,
        },
      },
    });
  });

  it("removes exhausted hidden coordination and drains the next user message", async () => {
    vi.useFakeTimers();
    const privateCoordination =
      "[Handoff handoff-3 from spokesperson; cursor 3] Private context";
    const sendMessage = vi.fn((text: string) => text === "normal user message");
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: privateCoordination,
      showInComposer: false,
      sendOptions: {
        userMessageMetadata: {
          origin: "voice_conversation",
          userVisible: false,
        },
      },
    });
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "normal user message",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(sendMessage).toHaveBeenCalledTimes(6);
    expect(sendMessage.mock.calls.at(-1)?.[0]).toBe("normal user message");
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    expect(loadCachedMessageQueues()).toEqual({});
    expect(mocks.stopRealtimeForSession).toHaveBeenCalledOnce();
    expect(mocks.stopRealtimeForSession).toHaveBeenCalledWith("s1");
    expect(mocks.toastError).toHaveBeenCalledOnce();

    const visibleMessages = useChatStore.getState().messagesBySession.s1;
    expect(visibleMessages).toHaveLength(1);
    expect(visibleMessages?.[0]).toMatchObject({
      role: "system",
      content: [
        {
          type: "systemNotification",
          notificationType: "error",
        },
      ],
      metadata: { userVisible: true, agentVisible: false },
    });
    expect(JSON.stringify(visibleMessages)).not.toContain(privateCoordination);
    vi.useRealTimers();
  });

  it("retries the same failed head on every later readiness transition", () => {
    const sendMessage = vi.fn().mockReturnValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });
    rerender({ chatState: "streaming" as const });
    rerender({ chatState: "idle" as const });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "queued",
    });
  });

  it("resets the retry backoff on every later readiness transition", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockReturnValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);

    act(() => {
      useChatStore.getState().setChatState("s1", "streaming");
      useChatStore.getState().setChatState("s1", "idle");
    });
    expect(sendMessage).toHaveBeenCalledTimes(4);

    // The idle transition cleared the backoff, so the next automatic retry
    // fires at the initial one-second delay again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({ text: "queued" });
    vi.useRealTimers();
  });

  it("drains queued message via store subscription when chatState transitions to idle (background-safe path)", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });

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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("keeps the background subscription blocked until preparation is ready", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
    chatStore.setChatState("s1", "streaming");

    const { rerender } = renderHook(
      ({ preparationReady }: { preparationReady: boolean }) =>
        useMessageQueue(
          "s1",
          preparationReady ? "idle" : "thinking",
          sendMessage,
          false,
          false,
          preparationReady,
        ),
      { initialProps: { preparationReady: false } },
    );

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({ preparationReady: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("reads live blocked state before draining via store subscription", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("drains when a run clears after chatState is already idle", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
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
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("keeps a hung attempt fenced across owner remounts", () => {
    const sendMessage = vi.fn(() => new Promise<boolean>(() => {}));
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
    chatStore.setChatState("s1", "streaming");

    const firstOwner = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );
    act(() => chatStore.setChatState("s1", "idle"));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstOwner.unmount();
    renderHook(() => useMessageQueue("s1", "idle", sendMessage));

    expect(sendMessage).toHaveBeenCalledTimes(1);
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
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
    chatStore.setChatState("s1", "streaming");

    renderHook(() => useMessageQueue("s1", "streaming", sendMessage));

    act(() => {
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
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
