import {
  clearWorkspaceToolCallObservations,
  observeWorkspaceToolCall,
} from "./acpWorkspaceObservation";
import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  getBufferedMessage,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import type {
  MessageContent,
  MessageMetadata,
  ToolCallLocation,
  ToolKind,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  clearActiveMessageId,
  clearActiveMessageTracking,
  getActiveMessagePreset,
  recordLiveAgentMessageChunk,
} from "@/shared/api/acpActiveMessageTracking";
import type { AcpNotificationHandler } from "@/shared/api/acpConnection";
import {
  clearSkillReplayChips,
  handleReplayUserMessageChunk,
} from "./acpSkillReplayChips";
import {
  attachMcpAppPayload,
  extractToolResultImages,
  extractToolStructuredContent,
  extractToolResultText,
  findReplayMessageWithToolCall,
} from "./acpToolCallContent";
import {
  clearReplayAssistantTracking,
  completeReplayAssistantMessage,
  ensureReplayAssistantMessage,
  getTrackedReplayAssistantMessageId,
} from "./acpReplayAssistant";
import {
  getReplayAssistantMetadata,
  getReplayCreated,
  getReplayMessageId,
  getReplayUserMetadata,
} from "@/shared/api/acpReplayMetadata";
import { handleSessionInfoUpdate } from "./acpSessionInfoUpdate";
import {
  getToolCallIdentity,
  getToolChainSummary,
} from "@/shared/api/acpToolCallIdentity";
import {
  getSubagentToolCallContext,
  resolveSubagentContext,
} from "@/features/chat/lib/subagentToolCalls";
import { getSessionPromptOwner } from "@/features/chat/lib/sessionPromptOwnership";
import { applyChatSessionConfigOptionsSnapshot } from "./sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import {
  enqueueStreamingTextUpdate,
  enqueueStreamingThinkingUpdate,
  flushBufferedStreamingUpdatesForSession,
  clearStreamingMessageOwners,
  isStreamingMessageOwnedByCurrentPrompt,
  registerStreamingMessageOwner,
} from "./liveStreamingUpdates";

// Per-session perf counters for replay streaming.
interface ReplayPerf {
  firstAt: number;
  lastAt: number;
  count: number;
}
const replayPerf = new Map<string, ReplayPerf>();
interface ReplayAgentBoundaryCandidate {
  messageId: string;
  precedingAssistantMessageId: string | null;
}
const pendingReplayAgentBoundaryCandidates = new Map<
  string,
  ReplayAgentBoundaryCandidate[]
>();
const replayAssistantMessageIds = new Map<string, string>();
const replayAgentBoundaryActive = new Set<string>();

function enqueueReplayAgentBoundaryCandidate(
  sessionId: string,
  messageId: string,
): void {
  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId) ?? [];
  if (!candidates.some((candidate) => candidate.messageId === messageId)) {
    candidates.push({
      messageId,
      precedingAssistantMessageId:
        replayAssistantMessageIds.get(sessionId) ?? null,
    });
    pendingReplayAgentBoundaryCandidates.set(sessionId, candidates);
  }
  replayAgentBoundaryActive.delete(sessionId);
}

function removeReplayAgentBoundaryCandidate(
  sessionId: string,
  messageId: string,
): void {
  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
  if (!candidates?.some((candidate) => candidate.messageId === messageId)) {
    return;
  }
  const remainingCandidates = candidates.filter(
    (candidate) => candidate.messageId !== messageId,
  );
  if (remainingCandidates.length === 0) {
    pendingReplayAgentBoundaryCandidates.delete(sessionId);
  } else {
    pendingReplayAgentBoundaryCandidates.set(sessionId, remainingCandidates);
  }
}

function handleReplayAssistantBoundary(
  sessionId: string,
  update: SessionUpdate,
): void {
  const replayMessageId = getReplayMessageId(update);
  const assistantMessageId =
    replayMessageId ?? replayAssistantMessageIds.get(sessionId) ?? "anonymous";
  const previousAssistantMessageId =
    replayAssistantMessageIds.get(sessionId) ?? null;
  const isNewAssistantMessage =
    previousAssistantMessageId !== assistantMessageId;
  const isInterventionBoundary = isRunInterventionBoundary(update);

  if (!isInterventionBoundary) {
    replayAgentBoundaryActive.delete(sessionId);
    if (isNewAssistantMessage) {
      const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
      const remainingCandidates = candidates?.filter(
        (candidate) =>
          candidate.precedingAssistantMessageId !== previousAssistantMessageId,
      );
      if (remainingCandidates?.length) {
        pendingReplayAgentBoundaryCandidates.set(
          sessionId,
          remainingCandidates,
        );
      } else {
        pendingReplayAgentBoundaryCandidates.delete(sessionId);
      }
    }
    replayAssistantMessageIds.set(sessionId, assistantMessageId);
    return;
  }

  replayAssistantMessageIds.set(sessionId, assistantMessageId);
  if (replayAgentBoundaryActive.has(sessionId)) return;
  replayAgentBoundaryActive.add(sessionId);

  const candidates = pendingReplayAgentBoundaryCandidates.get(sessionId);
  const deliveredCandidate = candidates?.shift();
  if (!candidates || candidates.length === 0) {
    pendingReplayAgentBoundaryCandidates.delete(sessionId);
  }
  if (!deliveredCandidate) return;

  const deliveredMessage = getReplayBuffer(sessionId)?.find(
    (message) => message.id === deliveredCandidate.messageId,
  );
  if (deliveredMessage) {
    deliveredMessage.metadata = {
      ...deliveredMessage.metadata,
      delivery: "steer",
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawInputToArguments(rawInput: unknown): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}

function toolKindFromUpdate(update: SessionUpdate): ToolKind | undefined {
  const record: Record<string, unknown> = update;
  const value = record.kind;
  return typeof value === "string" ? (value as ToolKind) : undefined;
}

function locationsFromUpdate(
  update: SessionUpdate,
): ToolCallLocation[] | undefined {
  const record: Record<string, unknown> = update;
  const value = record.locations;
  if (!Array.isArray(value)) return undefined;

  return value
    .filter(
      (location): location is { path: string; line?: number | null } =>
        isRecord(location) && typeof location.path === "string",
    )
    .map((location) => ({
      path: location.path,
      ...(typeof location.line === "number" || location.line === null
        ? { line: location.line }
        : {}),
    }));
}

function toolCallUpdatePatch(
  update: SessionUpdate,
): Pick<Partial<ToolRequestContent>, "toolKind" | "locations"> {
  const toolKind = toolKindFromUpdate(update);
  const locations = locationsFromUpdate(update);

  return {
    ...(toolKind ? { toolKind } : {}),
    ...(locations ? { locations } : {}),
  };
}

export async function handleSessionNotification(
  notification: SessionNotification,
): Promise<void> {
  const sessionId = notification.sessionId;
  const { update } = notification;
  // A newly-created session can still be hydrating when its first local prompt
  // starts. Notifications from that owned prompt are live output, even while
  // the history-loading flag is set. Routing them into the replay buffer loses
  // them when replay has already taken its snapshot (realtime voice makes this
  // race easy to hit because it can dispatch immediately after session start).
  const isReplay =
    useChatStore.getState().loadingSessionIds.has(sessionId) &&
    getSessionPromptOwner(sessionId) === null;
  if (isReplay) {
    const sid = sessionId.slice(0, 8);
    let perf = replayPerf.get(sessionId);
    const now = performance.now();
    if (!perf) {
      perf = { firstAt: now, lastAt: now, count: 0 };
      replayPerf.set(sessionId, perf);
      perfLog(`[perf:replay] ${sid} first notification received`);
    }
    perf.lastAt = now;
    perf.count += 1;
    handleReplay(sessionId, update);
  } else {
    observeWorkspaceToolCall(sessionId, update);
    if (update.sessionUpdate === "agent_message_chunk") {
      recordLiveAgentMessageChunk(sessionId);
    }
    handleLive(sessionId, update);
  }
}

export function getReplayPerf(
  sessionId: string,
): { count: number; spanMs: number } | null {
  const perf = replayPerf.get(sessionId);
  if (!perf) return null;
  return { count: perf.count, spanMs: perf.lastAt - perf.firstAt };
}

export function clearReplayPerf(sessionId: string): void {
  replayPerf.delete(sessionId);
}

function getChunkMessageId(update: SessionUpdate): string | null {
  return "messageId" in update && typeof update.messageId === "string"
    ? update.messageId
    : null;
}

function isRunInterventionBoundary(update: SessionUpdate): boolean {
  const record: Record<string, unknown> = update;
  const meta = record._meta;
  if (!isRecord(meta)) {
    return false;
  }
  // Goose currently marks a mid-run steer echo as the intervention boundary.
  // Keep that backend-specific shape at the ACP edge so the chat store only
  // has to reason about generic intervention boundaries.
  const goose = meta.goose;
  return isRecord(goose) && goose.steer === true;
}

function markSteerDelivered(sessionId: string, update: SessionUpdate): void {
  const store = useChatStore.getState();
  const messages = store.messagesBySession[sessionId];
  const deliveredMessageId =
    update.sessionUpdate === "user_message_chunk"
      ? getChunkMessageId(update)
      : null;
  const messageId =
    deliveredMessageId &&
    messages?.some((message) => message.id === deliveredMessageId)
      ? deliveredMessageId
      : messages?.find(
          // Goose picks up queued steers in request order. Match a boundary
          // that beats its response to the oldest steer still awaiting pickup
          // rather than the latest session-wide intervention boundary.
          (message) =>
            message.role === "user" &&
            message.metadata?.delivery === "steering",
        )?.id;
  if (!messageId) return;

  const resolvedMessageId = deliveredMessageId ?? messageId;
  store.replaceMessageId(sessionId, messageId, resolvedMessageId);
  store.updateMessage(sessionId, resolvedMessageId, (message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      delivery: "steer",
    },
  }));
  store.setPendingInterventionBoundary(sessionId, {
    interventionMessageId: resolvedMessageId,
  });
}

function getReplayAssistantMessageMetadata(
  sessionId: string,
  update: SessionUpdate,
): Pick<MessageMetadata, "personaId" | "personaName"> | undefined {
  const updateMetadata = getReplayAssistantMetadata(update);
  if (updateMetadata) {
    return updateMetadata;
  }

  const personaId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.personaId;
  if (!personaId) {
    return undefined;
  }

  const personaName = useAgentStore
    .getState()
    .getPersonaById(personaId)?.displayName;
  return {
    personaId,
    ...(personaName ? { personaName } : {}),
  };
}

function upsertThinkingContent(content: MessageContent[], text: string): void {
  const last = content[content.length - 1];
  if (last?.type !== "thinking") {
    content.push({ type: "thinking", text });
    return;
  }

  if (text.startsWith(last.text)) {
    last.text = text;
    return;
  }
  if (last.text.endsWith(text)) {
    return;
  }
  last.text += text;
}

function handleReplay(sessionId: string, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      handleReplayAssistantBoundary(sessionId, update);
      const msg = ensureReplayAssistantMessage(
        sessionId,
        getReplayMessageId(update),
        getReplayCreated(update),
        getReplayAssistantMessageMetadata(sessionId, update),
      );
      if (update.content.type === "text" && "text" in update.content) {
        const last = msg.content[msg.content.length - 1];
        if (last?.type === "text") {
          (last as { type: "text"; text: string }).text += update.content.text;
        } else {
          msg.content.push({ type: "text", text: update.content.text });
        }
      } else if (update.content.type === "image") {
        msg.content.push({ ...update.content });
      }
      break;
    }

    case "agent_thought_chunk": {
      handleReplayAssistantBoundary(sessionId, update);
      if (update.content.type === "text" && "text" in update.content) {
        const msg = ensureReplayAssistantMessage(
          sessionId,
          getReplayMessageId(update),
          getReplayCreated(update),
          getReplayAssistantMessageMetadata(sessionId, update),
        );
        upsertThinkingContent(msg.content, update.content.text);
      }
      break;
    }

    case "user_message_chunk": {
      completeReplayAssistantMessage(sessionId);
      replayAssistantMessageIds.delete(sessionId);
      replayAgentBoundaryActive.delete(sessionId);
      if (update.content.type !== "text" && update.content.type !== "image") {
        break;
      }
      const messageId = getReplayMessageId(update) ?? crypto.randomUUID();
      const metadata = getReplayUserMetadata(update);
      handleReplayUserMessageChunk(
        sessionId,
        messageId,
        update.content,
        getReplayCreated(update),
        metadata,
      );
      if (metadata?.delivery === "steer") {
        removeReplayAgentBoundaryCandidate(sessionId, messageId);
      } else {
        enqueueReplayAgentBoundaryCandidate(sessionId, messageId);
      }
      break;
    }

    case "tool_call": {
      handleReplayAssistantBoundary(sessionId, update);
      const created = getReplayCreated(update);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);
      const msg = ensureReplayAssistantMessage(
        sessionId,
        getReplayMessageId(update),
        created,
        getReplayAssistantMessageMetadata(sessionId, update),
      );
      const replayArguments = rawInputToArguments(update.rawInput);
      const replaySubagentContext =
        getSubagentToolCallContext(identity.toolName, replayArguments) ??
        resolveSubagentContext(
          identity.toolName,
          replayArguments,
          getReplayBuffer(sessionId) ?? [],
        );
      msg.content.push({
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: replayArguments,
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: created ?? Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
        ...(replaySubagentContext ?? {}),
      });
      break;
    }

    case "tool_call_update": {
      handleReplayAssistantBoundary(sessionId, update);
      const created = getReplayCreated(update);
      const replayMessageId = getReplayMessageId(update);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);
      const trackedMessageId = getTrackedReplayAssistantMessageId(sessionId);
      const replayMsg = replayMessageId
        ? getBufferedMessage(sessionId, replayMessageId)
        : undefined;
      const trackedMsg =
        trackedMessageId && trackedMessageId !== replayMessageId
          ? getBufferedMessage(sessionId, trackedMessageId)
          : undefined;
      const existingMsg = findReplayMessageWithToolCall(
        sessionId,
        update.toolCallId,
      );
      const msg = existingMsg ?? replayMsg ?? trackedMsg;
      if (msg) {
        if (created !== undefined && !existingMsg && msg === replayMsg) {
          msg.created = created;
        }
        const patch = toolCallUpdatePatch(update);
        if (
          update.title ||
          Object.keys(identity).length > 0 ||
          Object.keys(patch).length > 0 ||
          chainSummary
        ) {
          const tc = msg.content.find(
            (c) => c.type === "toolRequest" && c.id === update.toolCallId,
          );
          if (tc && tc.type === "toolRequest") {
            Object.assign(tc as ToolRequestContent, {
              ...(update.title ? { name: update.title } : {}),
              ...identity,
              ...patch,
              ...(chainSummary ? { chainSummary } : {}),
            });
            // The wire tool name can arrive after the initial tool_call
            // (identity patched in by a later update); resolve the subagent
            // label now that we know what the tool is.
            if (
              identity.toolName &&
              (tc.subagentAgentName === undefined ||
                tc.subagentTaskLabel === undefined)
            ) {
              const lateContext =
                getSubagentToolCallContext(tc.toolName, tc.arguments) ??
                resolveSubagentContext(
                  tc.toolName,
                  tc.arguments,
                  getReplayBuffer(sessionId) ?? [],
                );
              if (lateContext) Object.assign(tc, lateContext);
            }
          }
        }
        if (update.status === "completed" || update.status === "failed") {
          const tc = msg.content.find(
            (c) => c.type === "toolRequest" && c.id === update.toolCallId,
          );
          if (tc && tc.type === "toolRequest") {
            const idx = msg.content.indexOf(tc);
            if (idx >= 0) {
              msg.content[idx] = {
                ...tc,
                ...identity,
                ...toolCallUpdatePatch(update),
                status: update.status,
              } as ToolRequestContent;
            }
          }
          const resultText = extractToolResultText(update);
          msg.content.push({
            type: "toolResponse",
            id: update.toolCallId,
            name: (tc as ToolRequestContent)?.name ?? "",
            result: resultText,
            structuredContent: extractToolStructuredContent(update),
            isError: update.status === "failed",
          });
          // Mirror the live branch: surface image blocks returned by the tool
          // so image-producing MCPs render inline on replay too.
          for (const image of extractToolResultImages(update)) {
            msg.content.push(image);
          }
          if (update.status === "completed") {
            attachMcpAppPayload(
              sessionId,
              update.toolCallId,
              (tc as ToolRequestContent)?.name ?? update.title ?? "",
              update,
              true,
              {
                replayMessageId,
              },
            );
          }
        }
      }
      break;
    }

    case "session_info_update":
    case "config_option_update":
    case "usage_update":
      handleShared(sessionId, update);
      break;

    default:
      break;
  }
}

function handleLive(sessionId: string, update: SessionUpdate): void {
  const store = useChatStore.getState();

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (isRunInterventionBoundary(update)) {
        flushBufferedStreamingUpdatesForSession(sessionId);
        markSteerDelivered(sessionId, update);
        store.startAssistantStreamAfterIntervention(sessionId);
        break;
      }

      const messageId = ensureLiveAssistantMessage(
        sessionId,
        getChunkMessageId(update) ?? undefined,
      );

      if (update.content.type === "text" && "text" in update.content) {
        enqueueStreamingTextUpdate(sessionId, messageId, update.content.text);
      } else if (update.content.type === "image") {
        if (!isStreamingMessageOwnedByCurrentPrompt(sessionId, messageId)) {
          break;
        }
        // Live counterpart to the replay path (see the replay
        // agent_message_chunk handler above): append an image content block to
        // the streaming assistant message so agent-emitted images render inline
        // during the turn, not only after reload. Without this branch image
        // chunks were silently dropped live. Ensure buffered text lands before
        // the image so content order stays identical to notification order.
        flushBufferedStreamingUpdatesForSession(sessionId);
        store.setStreamingMessageId(sessionId, messageId);
        store.appendToStreamingMessage(sessionId, { ...update.content });
      }
      break;
    }

    case "agent_thought_chunk": {
      if (update.content.type === "text" && "text" in update.content) {
        const messageId = ensureLiveAssistantMessage(
          sessionId,
          getChunkMessageId(update) ?? undefined,
        );
        enqueueStreamingThinkingUpdate(
          sessionId,
          messageId,
          update.content.text,
        );
      }
      break;
    }

    case "user_message_chunk": {
      if (isRunInterventionBoundary(update)) {
        flushBufferedStreamingUpdatesForSession(sessionId);
        markSteerDelivered(sessionId, update);
        store.startAssistantStreamAfterIntervention(sessionId);
      }
      break;
    }

    case "tool_call": {
      flushBufferedStreamingUpdatesForSession(sessionId);
      const messageId = ensureLiveAssistantMessage(sessionId);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);

      const liveArguments = rawInputToArguments(update.rawInput);
      const liveSubagentContext =
        getSubagentToolCallContext(identity.toolName, liveArguments) ??
        resolveSubagentContext(
          identity.toolName,
          liveArguments,
          useChatStore.getState().messagesBySession[sessionId] ?? [],
        );
      const toolRequest: ToolRequestContent = {
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: liveArguments,
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
        ...(liveSubagentContext ?? {}),
      };
      store.setStreamingMessageId(sessionId, messageId);
      store.appendToStreamingMessage(sessionId, toolRequest);
      break;
    }

    case "tool_call_update": {
      flushBufferedStreamingUpdatesForSession(sessionId);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);
      // Late-arriving updates (chain summaries, async titles) can target a
      // tool call whose request lives in an older message than the currently
      // streaming one. Patch the message that actually owns the tool call,
      // falling back to ensureLiveAssistantMessage only if we can't find it.
      const ownerMessageId = findLiveMessageIdWithToolCall(
        sessionId,
        update.toolCallId,
      );
      const messageId = ownerMessageId ?? ensureLiveAssistantMessage(sessionId);

      const patch = toolCallUpdatePatch(update);
      if (
        update.title ||
        Object.keys(identity).length > 0 ||
        Object.keys(patch).length > 0 ||
        chainSummary
      ) {
        // The wire tool name can arrive after the initial tool_call
        // (identity patched in by a later update); resolve the subagent
        // label now that we know what the tool is.
        const storedArguments = identity.toolName
          ? (findLiveToolRequest(sessionId, messageId, update.toolCallId)
              ?.arguments ?? {})
          : {};
        const lateSubagentContext = identity.toolName
          ? (getSubagentToolCallContext(identity.toolName, storedArguments) ??
            resolveSubagentContext(
              identity.toolName,
              storedArguments,
              useChatStore.getState().messagesBySession[sessionId] ?? [],
            ))
          : undefined;
        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: msg.content.map((c) =>
            c.type === "toolRequest" && c.id === update.toolCallId
              ? {
                  ...c,
                  ...(update.title ? { name: update.title } : {}),
                  ...identity,
                  ...patch,
                  ...(chainSummary ? { chainSummary } : {}),
                  ...(lateSubagentContext ?? {}),
                }
              : c,
          ),
        }));
      }

      if (update.status === "completed" || update.status === "failed") {
        const { status: resolvedStatus } = update;
        const ownerMessage = store.messagesBySession[sessionId]?.find(
          (m) => m.id === messageId,
        );
        // Look up the request that this update belongs to by exact id —
        // sibling tools can complete out of order, so the latest unpaired
        // request isn't necessarily the one we're updating. Mirrors the
        // replay branch above.
        const toolRequest =
          ownerMessage?.content.find(
            (block): block is ToolRequestContent =>
              block.type === "toolRequest" && block.id === update.toolCallId,
          ) ?? null;

        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: msg.content.map((block) =>
            block.type === "toolRequest" && block.id === update.toolCallId
              ? {
                  ...block,
                  ...identity,
                  ...toolCallUpdatePatch(update),
                  status: resolvedStatus,
                }
              : block,
          ),
        }));

        const resultText = extractToolResultText(update);
        const toolResponse: ToolResponseContent = {
          type: "toolResponse",
          id: update.toolCallId,
          name: toolRequest?.name ?? update.title ?? "",
          result: resultText,
          structuredContent: extractToolStructuredContent(update),
          isError: update.status === "failed",
        };
        store.updateMessage(sessionId, messageId, (msg) => ({
          ...msg,
          content: [...msg.content, toolResponse],
        }));
        // Append any image blocks the tool returned so image-producing MCPs
        // (e.g. imagegenerator) render inline rather than only as text/JSON.
        const toolImages = extractToolResultImages(update);
        if (toolImages.length > 0) {
          store.updateMessage(sessionId, messageId, (msg) => ({
            ...msg,
            content: [...msg.content, ...toolImages],
          }));
        }
        if (update.status === "completed") {
          attachMcpAppPayload(
            sessionId,
            update.toolCallId,
            toolRequest?.name ?? update.title ?? "",
            update,
            false,
          );
        }
      }
      break;
    }

    case "session_info_update":
    case "config_option_update":
    case "usage_update":
      flushBufferedStreamingUpdatesForSession(sessionId);
      handleShared(sessionId, update);
      break;

    default:
      break;
  }
}

function handleShared(sessionId: string, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "session_info_update": {
      handleSessionInfoUpdate(sessionId, update);
      break;
    }

    case "config_option_update": {
      applyChatSessionConfigOptionsSnapshot(sessionId, update, {
        origin: "notification",
      });
      break;
    }

    case "usage_update": {
      const usage = update as SessionUpdate & {
        sessionUpdate: "usage_update";
        cost?: { amount?: number | null } | null;
      };

      // The standard ACP usage_update carries cumulative session cost (USD)
      // in `cost.amount`. Distinguish three cases so we don't drop a
      // previously-displayed cost when the backend simply omits cost on a
      // later usage update:
      //   - `cost` omitted (undefined)        -> preserve existing value
      //   - explicit `cost: null` / null amount -> clear (no pricing)
      //   - finite amount                      -> update
      // Only including `accumulatedCost` in the partial when cost is present
      // lets the store's preserve-on-`undefined` behavior kick in.
      let accumulatedCost: number | null | undefined;
      if (usage.cost === undefined) {
        accumulatedCost = undefined;
      } else if (typeof usage.cost?.amount === "number") {
        accumulatedCost = usage.cost.amount;
      } else {
        accumulatedCost = null;
      }

      useChatStore.getState().updateTokenState(sessionId, {
        accumulatedTotal: usage.used,
        contextLimit: usage.size,
        ...(accumulatedCost !== undefined ? { accumulatedCost } : {}),
      });
      break;
    }

    default:
      break;
  }
}

function findStreamingMessageId(sessionId: string): string | null {
  return useChatStore.getState().getSessionRuntime(sessionId)
    .streamingMessageId;
}

/**
 * Locate the live message that owns a given tool call id by scanning
 * `messagesBySession` from the most recent message backwards. Used by
 * `tool_call_update` to keep late-arriving updates (chain summaries, async
 * titles, status flips) anchored on the request's original message even when
 * the streaming pointer has moved on to the next assistant turn.
 */
function findLiveMessageIdWithToolCall(
  sessionId: string,
  toolCallId: string,
): string | null {
  const messages = useChatStore.getState().messagesBySession[sessionId];
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (
      messages[i].content.some(
        (c) => c.type === "toolRequest" && c.id === toolCallId,
      )
    ) {
      return messages[i].id;
    }
  }
  return null;
}

function findLiveToolRequest(
  sessionId: string,
  messageId: string,
  toolCallId: string,
): ToolRequestContent | undefined {
  const messages = useChatStore.getState().messagesBySession[sessionId];
  const message = messages?.find((m) => m.id === messageId);
  return message?.content.find(
    (c): c is ToolRequestContent =>
      c.type === "toolRequest" && c.id === toolCallId,
  );
}

function ensureLiveAssistantMessage(
  sessionId: string,
  preferredMessageId?: string | null,
): string {
  const store = useChatStore.getState();
  const existingStreamingMessageId = findStreamingMessageId(sessionId);
  const messages = store.messagesBySession[sessionId] ?? [];
  const activePreset = getActiveMessagePreset(sessionId);

  if (
    preferredMessageId &&
    preferredMessageId !== existingStreamingMessageId &&
    messages.some((message) => message.id === preferredMessageId)
  ) {
    registerStreamingMessageOwner(sessionId, preferredMessageId);
    return preferredMessageId;
  }

  if (
    existingStreamingMessageId &&
    messages.some((message) => message.id === existingStreamingMessageId)
  ) {
    if (activePreset?.metadata) {
      store.updateMessage(sessionId, existingStreamingMessageId, (message) => ({
        ...message,
        metadata: {
          ...message.metadata,
          ...activePreset.metadata,
        },
      }));
    }
    return existingStreamingMessageId;
  }

  const messageId =
    preferredMessageId ??
    activePreset?.messageId ??
    existingStreamingMessageId ??
    crypto.randomUUID();

  if (!messages.some((message) => message.id === messageId)) {
    store.addMessage(sessionId, {
      id: messageId,
      role: "assistant",
      created: Date.now(),
      content: [],
      metadata: {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
        ...activePreset?.metadata,
      },
    });
  }

  registerStreamingMessageOwner(sessionId, messageId);
  store.setPendingAssistantProvider(sessionId, null);
  store.setStreamingMessageId(sessionId, messageId);
  clearActiveMessageId(sessionId);

  return messageId;
}

export function clearMessageTracking(): void {
  pendingReplayAgentBoundaryCandidates.clear();
  replayAssistantMessageIds.clear();
  replayAgentBoundaryActive.clear();
  clearStreamingMessageOwners();
  clearActiveMessageTracking();
  clearReplayAssistantTracking();
  clearSkillReplayChips();
  clearWorkspaceToolCallObservations();
}

const handler: AcpNotificationHandler = {
  handleSessionNotification,
};

export default handler;
