import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acknowledgeAutomationTileDraft,
  applyAutomationBuilderDelta,
  automationBuilderErrorMessage,
  asStreamResponse,
  cancelAutomationBuilderMessage,
  createAutomationTileFromDraft,
  findAutomationDraftState,
  listenToAutomationBuilderStream,
  pushAutomationBuilderUserMessage,
  reviseAutomationDraft,
  startAutomationBuilderStream,
  stopAutomationBuilderStream,
  type AutomationBuilderStatus,
  type AutomationDraft,
  type AutomationDraftState,
} from "@/features/automations/api/automationBuilder";
import {
  getAutomationTile,
  updateAutomationTile,
  type AutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import {
  createUserMessage,
  getTextContent,
  type Message,
} from "@/shared/types/messages";

const LOCAL_USER_MESSAGE_ID_PREFIX = "automation-builder-local-";
const RECONNECT_AFTER_COMPLETED_DELAY_MS = 1_000;
const MAX_PENDING_COMPLETED_RECONNECTS = 3;

interface UseAutomationBuilderSessionOptions {
  /**
   * When set, the session enters edit mode: the rail seeds from the existing
   * tile and approval calls `update_automation_tile` instead of
   * `create_automation_tile`.
   */
  automationId?: string;
  onAutomationCreated?: (automationId?: string) => void;
  onAutomationUpdated?: (automationId?: string) => void;
}

function buildSeedDraftFromTile(tile: AutomationTile): AutomationDraft | null {
  if (!tile.id) return null;
  const instructions = Array.isArray(tile.instructions)
    ? tile.instructions
    : [];
  const humanReadableInstructions = Array.isArray(
    tile.humanReadableInstructions,
  )
    ? tile.humanReadableInstructions
    : [];
  return {
    toolRequestId: `edit-${tile.id}`,
    toolName: "automation edit",
    title: typeof tile.title === "string" ? tile.title : undefined,
    schedule: typeof tile.schedule === "string" ? tile.schedule : undefined,
    instructions,
    humanReadableInstructions,
    enableNotifications:
      typeof tile.enableNotifications === "boolean"
        ? tile.enableNotifications
        : undefined,
    timeZone: typeof tile.timeZone === "string" ? tile.timeZone : undefined,
    rawArguments: {},
    creationMode: "createTile",
  };
}

function messagesEquivalent(a: Message, b: Message) {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.created === b.created &&
    JSON.stringify(a.content) === JSON.stringify(b.content) &&
    JSON.stringify(a.metadata ?? {}) === JSON.stringify(b.metadata ?? {})
  );
}

function isLocalUserEcho(local: Message, incoming: Message) {
  return (
    local.id.startsWith(LOCAL_USER_MESSAGE_ID_PREFIX) &&
    local.role === "user" &&
    incoming.role === "user" &&
    getTextContent(local).trim() === getTextContent(incoming).trim()
  );
}

function mergeSnapshotMessages(current: Message[], incoming: Message[]) {
  if (incoming.length === 0) {
    return current;
  }

  const next = [...current];
  let changed = false;

  for (const incomingMessage of incoming) {
    const existingIndex = next.findIndex(
      (message) => message.id === incomingMessage.id,
    );
    if (existingIndex !== -1) {
      if (!messagesEquivalent(next[existingIndex], incomingMessage)) {
        next[existingIndex] = incomingMessage;
        changed = true;
      }
      continue;
    }

    const localEchoIndex = next.findIndex((message) =>
      isLocalUserEcho(message, incomingMessage),
    );
    if (localEchoIndex !== -1) {
      next[localEchoIndex] = incomingMessage;
      changed = true;
      continue;
    }

    next.push(incomingMessage);
    changed = true;
  }

  if (!changed) {
    return current;
  }

  return next;
}

function getErrorMessageText(message: Message, fallback: string | null = null) {
  const [content] = message.content;
  return content?.type === "systemNotification" ? content.text : fallback;
}

function createDeferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function useAutomationBuilderSession({
  automationId,
  onAutomationCreated,
  onAutomationUpdated,
}: UseAutomationBuilderSessionOptions = {}) {
  const isEditing = Boolean(automationId);
  const [seedDraftState, setSeedDraftState] = useState<{
    automationId: string;
    draft: AutomationDraft | null;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<AutomationBuilderStatus>("initialized");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const streamIdRef = useRef(`automation-builder-${crypto.randomUUID()}`);
  const sessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<AutomationBuilderStatus>("initialized");
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const createdNotifiedRef = useRef<string | null>(null);
  const pendingTurnRef = useRef(false);
  const lastSnapshotMessageIdRef = useRef<string | undefined>(undefined);
  const pendingCompletedReconnectsRef = useRef(0);
  const operationInFlightRef = useRef(false);
  const [locallyCreatedAutomation, setLocallyCreatedAutomation] = useState<{
    toolRequestId: string;
    automationId?: string;
  } | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const listenerReadyRef = useRef(createDeferred());
  const [draftOverrideState, setDraftOverrideState] = useState<{
    toolRequestId: string | null;
    overrides: Partial<AutomationDraft>;
  }>({ toolRequestId: null, overrides: {} });

  const setSessionIdValue = useCallback((value: string | null) => {
    sessionIdRef.current = value;
    setSessionId(value);
  }, []);

  const setStatusValue = useCallback((value: AutomationBuilderStatus) => {
    statusRef.current = value;
    setStatus(value);
  }, []);

  const clearPendingTurn = useCallback(() => {
    pendingTurnRef.current = false;
    pendingCompletedReconnectsRef.current = 0;
    setStreamingMessageId(null);
  }, []);

  const messageDraftState = useMemo(
    () => findAutomationDraftState(messages),
    [messages],
  );
  const seedDraft =
    automationId && seedDraftState?.automationId === automationId
      ? seedDraftState.draft
      : null;
  // In edit mode, fall back to the seed draft (synthesized from the existing
  // tile) until the chat emits its own draft via a tool call.
  const draftState = useMemo<AutomationDraftState>(() => {
    if (messageDraftState.draft || !seedDraft) {
      return messageDraftState;
    }
    return {
      draft: seedDraft,
      blockedToolRequest: null,
      createRequested: false,
      created: false,
      createdAutomationId: undefined,
      failed: false,
    };
  }, [messageDraftState, seedDraft]);
  const effectiveDraftState = useMemo(() => {
    if (
      !locallyCreatedAutomation ||
      draftState.draft?.toolRequestId !== locallyCreatedAutomation.toolRequestId
    ) {
      return draftState;
    }

    return {
      ...draftState,
      created: true,
      createRequested: false,
      createdAutomationId:
        draftState.createdAutomationId ?? locallyCreatedAutomation.automationId,
    };
  }, [draftState, locallyCreatedAutomation]);

  const activeDraftToolRequestId =
    effectiveDraftState.draft?.toolRequestId ?? null;
  if (draftOverrideState.toolRequestId !== activeDraftToolRequestId) {
    setDraftOverrideState({
      toolRequestId: activeDraftToolRequestId,
      overrides: {},
    });
  }
  const activeDraftOverrides =
    activeDraftToolRequestId &&
    draftOverrideState.toolRequestId === activeDraftToolRequestId &&
    !effectiveDraftState.created
      ? draftOverrideState.overrides
      : {};
  const hasActiveDraftOverrides = Object.keys(activeDraftOverrides).length > 0;

  const setDraftOverride = useCallback(
    (overrides: Partial<AutomationDraft>) => {
      setDraftOverrideState((current) => ({
        toolRequestId: activeDraftToolRequestId,
        overrides:
          current.toolRequestId === activeDraftToolRequestId
            ? { ...current.overrides, ...overrides }
            : overrides,
      }));
    },
    [activeDraftToolRequestId],
  );

  const mergedDraftState = useMemo(() => {
    if (!effectiveDraftState.draft) return effectiveDraftState;
    return {
      ...effectiveDraftState,
      draft: {
        ...effectiveDraftState.draft,
        ...activeDraftOverrides,
      },
    };
  }, [effectiveDraftState, activeDraftOverrides]);
  const hasUnsavedDraftChanges =
    Boolean(mergedDraftState.draft) &&
    !mergedDraftState.created &&
    (Boolean(messageDraftState.draft) || hasActiveDraftOverrides || !isEditing);

  // Fetch the existing tile in edit mode and synthesize the seed draft.
  useEffect(() => {
    if (!automationId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await getAutomationTile(automationId);
        if (cancelled) return;
        if (response.tileInfo) {
          setSeedDraftState({
            automationId,
            draft: buildSeedDraftFromTile(response.tileInfo),
          });
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to load automation for editing:", error);
        setError("Couldn't load this automation to edit.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automationId]);

  useEffect(() => {
    if (!mergedDraftState.created) return;

    const createdKey =
      mergedDraftState.createdAutomationId ??
      mergedDraftState.draft?.toolRequestId ??
      "created";
    if (createdNotifiedRef.current !== createdKey) {
      createdNotifiedRef.current = createdKey;
      onAutomationCreated?.(mergedDraftState.createdAutomationId);
    }
  }, [mergedDraftState, onAutomationCreated]);

  const openStream = useCallback(async (nextSessionId: string) => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    await listenerReadyRef.current.promise;
    await startAutomationBuilderStream(
      nextSessionId,
      streamIdRef.current,
      lastEventIdRef.current,
    );
  }, []);

  const markTurnProcessing = useCallback(
    async (nextSessionId: string) => {
      pendingTurnRef.current = true;
      setStatusValue("processing");
      try {
        await openStream(nextSessionId);
      } catch (error) {
        clearPendingTurn();
        setStatusValue("idle");
        throw error;
      }
    },
    [clearPendingTurn, openStream, setStatusValue],
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const listenerReady = createDeferred();
    listenerReadyRef.current = listenerReady;
    void listenToAutomationBuilderStream((event) => {
      if (
        !active ||
        event.streamId !== streamIdRef.current ||
        event.sessionId !== sessionIdRef.current
      ) {
        return;
      }

      if (event.id) {
        lastEventIdRef.current = event.id;
      }

      if (event.event === "error") {
        const message = event.error ?? "Automation builder stream failed.";
        setError(message);
        setMessages((current) => [
          ...current,
          automationBuilderErrorMessage(message),
        ]);
        clearPendingTurn();
        setStatusValue("idle");
        return;
      }

      if (event.event === "warning") {
        if (event.error) {
          setError(event.error);
        }
        return;
      }

      if (event.event === "completed") {
        if (
          (statusRef.current === "processing" || pendingTurnRef.current) &&
          pendingCompletedReconnectsRef.current <
            MAX_PENDING_COMPLETED_RECONNECTS
        ) {
          pendingCompletedReconnectsRef.current += 1;
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          reconnectTimeoutRef.current = setTimeout(() => {
            if (active && sessionIdRef.current) {
              void openStream(sessionIdRef.current);
            }
          }, RECONNECT_AFTER_COMPLETED_DELAY_MS);
        } else if (pendingTurnRef.current) {
          clearPendingTurn();
          setStatusValue("idle");
        }
        return;
      }

      if (event.event !== "messages" || !event.data) {
        return;
      }

      const streamResponse = asStreamResponse(event.data);
      if (!streamResponse) return;

      if (streamResponse.type === "messages") {
        const lastSnapshotMessageId =
          streamResponse.response.messages.at(-1)?.id;
        if (
          pendingTurnRef.current &&
          streamResponse.response.status === "idle" &&
          lastSnapshotMessageId === lastSnapshotMessageIdRef.current
        ) {
          return;
        }
        lastSnapshotMessageIdRef.current = lastSnapshotMessageId;
        if (streamResponse.response.status !== "initialized") {
          clearPendingTurn();
        }
        setMessages((current) =>
          mergeSnapshotMessages(current, streamResponse.response.messages),
        );
        setStatusValue(streamResponse.response.status);
        if (streamResponse.response.status !== "processing") {
          setStreamingMessageId(null);
        }
        return;
      }

      setStreamingMessageId(streamResponse.delta.streamingMessageId ?? null);
      setMessages((current) =>
        applyAutomationBuilderDelta(current, streamResponse.delta),
      );
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
        listenerReady.resolve();
      })
      .catch((error) => {
        listenerReady.reject(error);
      });
    void listenerReady.promise.catch((error) => {
      if (!active) return;
      const message = automationBuilderErrorMessage(error);
      setError(
        getErrorMessageText(
          message,
          "Automation builder stream listener failed.",
        ),
      );
      setMessages((current) => [...current, message]);
    });

    return () => {
      active = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      unlisten?.();
      void stopAutomationBuilderStream(streamIdRef.current);
    };
  }, [clearPendingTurn, openStream, setStatusValue]);

  const addErrorMessage = useCallback((error: unknown) => {
    const message = automationBuilderErrorMessage(error);
    setError(getErrorMessageText(message));
    setMessages((current) => [...current, message]);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSubmitting || operationInFlightRef.current) {
        return false;
      }

      operationInFlightRef.current = true;
      setIsSubmitting(true);
      setError(null);
      const localMessageId = `${LOCAL_USER_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
      setMessages((current) => [
        ...current,
        {
          ...createUserMessage(trimmed),
          id: localMessageId,
        },
      ]);

      let pushed = false;
      try {
        const revisionToolRequestId =
          statusRef.current === "needClientInput"
            ? messageDraftState.draft?.toolRequestId
            : undefined;
        if (sessionIdRef.current && revisionToolRequestId) {
          const result = await reviseAutomationDraft(
            sessionIdRef.current,
            revisionToolRequestId,
            trimmed,
          );
          pushed = true;
          const nextSessionId = result.sessionId ?? sessionIdRef.current;
          await markTurnProcessing(nextSessionId);
          return true;
        }

        const editContext =
          !sessionIdRef.current && seedDraft
            ? {
                title: seedDraft.title,
                schedule: seedDraft.schedule,
                timeZone: seedDraft.timeZone,
                instructions: seedDraft.instructions,
                humanReadableInstructions: seedDraft.humanReadableInstructions,
              }
            : undefined;
        const result = await pushAutomationBuilderUserMessage(
          trimmed,
          sessionIdRef.current ?? undefined,
          editContext,
        );
        pushed = true;
        const nextSessionId = result.sessionId ?? sessionIdRef.current;
        if (!nextSessionId) {
          throw new Error("kgoose did not return a session id.");
        }
        if (!sessionIdRef.current) {
          setSessionIdValue(nextSessionId);
        }
        await markTurnProcessing(nextSessionId);
        return true;
      } catch (error) {
        if (!pushed) {
          setMessages((current) =>
            current.filter((message) => message.id !== localMessageId),
          );
        }
        addErrorMessage(error);
        return false;
      } finally {
        setIsSubmitting(false);
        operationInFlightRef.current = false;
      }
    },
    [
      addErrorMessage,
      isSubmitting,
      markTurnProcessing,
      messageDraftState.draft?.toolRequestId,
      seedDraft,
      setSessionIdValue,
    ],
  );

  const approveDraft = useCallback(async () => {
    if (
      !mergedDraftState.draft ||
      isSubmitting ||
      operationInFlightRef.current
    ) {
      return false;
    }
    const currentSessionId = sessionIdRef.current;
    // Create path needs an active chat session to acknowledge the tool call.
    // Edit path bypasses the chat — it calls update_automation_tile directly.
    if (!isEditing && !currentSessionId) {
      return false;
    }

    operationInFlightRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      const draft = mergedDraftState.draft;

      if (isEditing && automationId) {
        const result = await updateAutomationTile({
          id: automationId,
          title: draft.title,
          schedule: draft.schedule,
          updateSchedule: true,
          timeZone: draft.timeZone,
          instructions: draft.instructions,
          updateInstructions: true,
          enableNotifications: draft.enableNotifications,
        });
        if (result.success !== true) {
          throw new Error(result.errorMsg || "Failed to update automation.");
        }
        setLocallyCreatedAutomation({
          toolRequestId: draft.toolRequestId,
          automationId,
        });
        onAutomationUpdated?.(automationId);
        if (
          currentSessionId &&
          messageDraftState.draft?.toolRequestId === draft.toolRequestId
        ) {
          await acknowledgeAutomationTileDraft(
            currentSessionId,
            draft.toolRequestId,
          );
          await markTurnProcessing(currentSessionId);
        }
        return true;
      }

      let shouldOpenStream = true;
      const result = await createAutomationTileFromDraft(draft);
      if (result.success !== true || !result.tileId) {
        throw new Error(result.errorMsg || "Failed to create automation.");
      }
      setLocallyCreatedAutomation({
        toolRequestId: draft.toolRequestId,
        automationId: result.tileId,
      });

      try {
        if (currentSessionId) {
          await acknowledgeAutomationTileDraft(
            currentSessionId,
            draft.toolRequestId,
          );
        }
      } catch (acknowledgementError) {
        const message = automationBuilderErrorMessage(acknowledgementError);
        setMessages((current) => [...current, message]);
        shouldOpenStream = false;
      }
      if (shouldOpenStream && currentSessionId) {
        await markTurnProcessing(currentSessionId);
      }
      return true;
    } catch (error) {
      clearPendingTurn();
      setStatusValue("idle");
      addErrorMessage(error);
      return false;
    } finally {
      setIsSubmitting(false);
      operationInFlightRef.current = false;
    }
  }, [
    addErrorMessage,
    automationId,
    clearPendingTurn,
    isEditing,
    isSubmitting,
    markTurnProcessing,
    messageDraftState.draft?.toolRequestId,
    mergedDraftState.draft,
    onAutomationUpdated,
    setStatusValue,
  ]);

  const cancel = useCallback(async () => {
    if (!sessionIdRef.current || operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setStatusValue("cancelling");
    try {
      await cancelAutomationBuilderMessage(sessionIdRef.current);
      await openStream(sessionIdRef.current);
    } catch (error) {
      clearPendingTurn();
      setStatusValue("idle");
      addErrorMessage(error);
    } finally {
      operationInFlightRef.current = false;
    }
  }, [addErrorMessage, clearPendingTurn, openStream, setStatusValue]);

  return {
    sessionId,
    messages,
    status,
    isSubmitting,
    isStreaming: status === "processing" || Boolean(streamingMessageId),
    streamingMessageId,
    error,
    draftState: mergedDraftState,
    draftOverrides: activeDraftOverrides,
    hasUnsavedDraftChanges,
    setDraftOverride,
    sendMessage,
    approveDraft,
    cancel,
  };
}
