import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getBufferedMessage } from "@/features/chat/hooks/replayBuffer";
import type {
  MessageMetadata,
  ToolCallLocation,
  ToolKind,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { AcpNotificationHandler } from "./acpConnection";
import {
  clearSkillReplayChips,
  handleReplayUserMessageChunk,
} from "./acpSkillReplayChips";
import {
  attachMcpAppPayload,
  extractToolStructuredContent,
  extractToolResultText,
  findReplayMessageWithToolCall,
} from "./acpToolCallContent";
import {
  clearReplayAssistantMessage,
  clearReplayAssistantTracking,
  ensureReplayAssistantMessage,
  getTrackedReplayAssistantMessageId,
} from "./acpReplayAssistant";
import {
  getReplayAssistantMetadata,
  getReplayCreated,
  getReplayMessageId,
} from "./acpReplayMetadata";
import { handleSessionInfoUpdate } from "./acpSessionInfoUpdate";
import {
  getToolCallIdentity,
  getToolChainSummary,
} from "./acpToolCallIdentity";
import { perfLog } from "@/shared/lib/perfLog";

interface ActiveMessagePreset {
  messageId: string;
  metadata?: Pick<MessageMetadata, "personaId" | "personaName">;
}

// Pre-set message details for the next live stream per session.
const activeMessagePresets = new Map<string, ActiveMessagePreset>();

// Per-session perf counters for replay/live streaming.
interface ReplayPerf {
  firstAt: number;
  lastAt: number;
  count: number;
}
const replayPerf = new Map<string, ReplayPerf>();
interface LivePerf {
  sendStartedAt: number;
  firstChunkAt: number | null;
  chunkCount: number;
}
const livePerf = new Map<string, LivePerf>();

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

interface ModelConfigSnapshot {
  modelId: string;
  modelName: string;
}

function getStringProperty(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getModelOptions(
  options: unknown,
): Array<{ id: string; name: string }> {
  if (Array.isArray(options)) {
    return options.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (id) {
        return [{ id, name: getStringProperty(value, "name") ?? id }];
      }
      if (!Array.isArray(value.options)) {
        return [];
      }
      return getModelOptions(value.options);
    });
  }

  if (!isRecord(options)) {
    return [];
  }

  const type = getStringProperty(options, "type");
  if (type === "ungrouped") {
    const values = options.values;
    if (!Array.isArray(values)) {
      return [];
    }
    return values.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (!id) {
        return [];
      }
      return [{ id, name: getStringProperty(value, "name") ?? id }];
    });
  }

  if (type !== "grouped" || !Array.isArray(options.groups)) {
    return [];
  }

  return options.groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.options)) {
      return [];
    }
    return group.options.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (!id) {
        return [];
      }
      return [{ id, name: getStringProperty(value, "name") ?? id }];
    });
  });
}

function getModelConfigSnapshot(
  update: SessionUpdate,
): ModelConfigSnapshot | null {
  const configUpdate = update as SessionUpdate & {
    sessionUpdate: "config_option_update";
    options?: unknown;
    configOptions?: unknown;
  };
  const options = Array.isArray(configUpdate.configOptions)
    ? configUpdate.configOptions
    : configUpdate.options;
  if (!Array.isArray(options)) {
    return null;
  }

  const modelOption = options.find(
    (option) => isRecord(option) && option.category === "model",
  );
  if (!isRecord(modelOption)) {
    return null;
  }

  const select = isRecord(modelOption.kind) ? modelOption.kind : modelOption;
  if (select.type !== "select") {
    return null;
  }

  const modelId = getStringProperty(select, "currentValue");
  if (!modelId) {
    return null;
  }

  const availableModels = getModelOptions(select.options);
  const modelName =
    availableModels.find((model) => model.id === modelId)?.name ?? modelId;

  return { modelId, modelName };
}

function handleModelConfigSnapshot(
  sessionId: string,
  snapshot: ModelConfigSnapshot,
): void {
  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);
  const intent = sessionStore.getModelSelectionIntent(sessionId);
  const localModelId = session?.modelId;
  const snapshotMatchesLocalModel = localModelId === snapshot.modelId;
  const snapshotMatchesPendingIntent =
    intent?.kind === "model" && intent.modelId === snapshot.modelId;

  // Backend config snapshots can arrive out of order around a user-triggered
  // model switch. Once the UI has a local model, only accept snapshots that
  // confirm the local state or the active intent; otherwise a stale snapshot can
  // flip the picker back and re-trigger preference/bootstrap churn.
  if (
    snapshotMatchesLocalModel ||
    snapshotMatchesPendingIntent ||
    (!localModelId && !intent)
  ) {
    sessionStore.patchSession(sessionId, {
      modelId: snapshot.modelId,
      modelName: snapshot.modelName,
    });
    return;
  }

  console.warn("Dropped divergent ACP model config snapshot", {
    sessionId: sessionId.slice(0, 8),
    localModelId,
    snapshotModelId: snapshot.modelId,
    intentKind: intent?.kind,
    intentModelId: intent?.modelId,
  });
}

export function setActiveMessageId(
  sessionId: string,
  messageId: string,
  metadata?: ActiveMessagePreset["metadata"],
): void {
  activeMessagePresets.set(sessionId, { messageId, metadata });
  livePerf.set(sessionId, {
    sendStartedAt: performance.now(),
    firstChunkAt: null,
    chunkCount: 0,
  });
}

export function clearActiveMessageId(sessionId: string): void {
  activeMessagePresets.delete(sessionId);
  const perf = livePerf.get(sessionId);
  if (perf) {
    const sid = sessionId.slice(0, 8);
    const total = performance.now() - perf.sendStartedAt;
    const ttft =
      perf.firstChunkAt !== null
        ? (perf.firstChunkAt - perf.sendStartedAt).toFixed(1)
        : "n/a";
    perfLog(
      `[perf:stream] ${sid} stream ended — ttft=${ttft}ms total=${total.toFixed(1)}ms chunks=${perf.chunkCount}`,
    );
    livePerf.delete(sessionId);
  }
}

export async function handleSessionNotification(
  notification: SessionNotification,
): Promise<void> {
  const sessionId = notification.sessionId;
  const { update } = notification;
  const isReplay = useChatStore.getState().loadingSessionIds.has(sessionId);

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
    const perf = livePerf.get(sessionId);
    if (perf && update.sessionUpdate === "agent_message_chunk") {
      perf.chunkCount += 1;
      if (perf.firstChunkAt === null) {
        perf.firstChunkAt = performance.now();
        const sid = sessionId.slice(0, 8);
        perfLog(
          `[perf:stream] ${sid} first agent_message_chunk at ttft=${(perf.firstChunkAt - perf.sendStartedAt).toFixed(1)}ms`,
        );
      }
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

function handleReplay(sessionId: string, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
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

    case "user_message_chunk": {
      clearReplayAssistantMessage(sessionId);
      if (update.content.type !== "text" && update.content.type !== "image") {
        break;
      }
      const messageId = getReplayMessageId(update) ?? crypto.randomUUID();
      handleReplayUserMessageChunk(
        sessionId,
        messageId,
        update.content,
        getReplayCreated(update),
      );
      break;
    }

    case "tool_call": {
      const created = getReplayCreated(update);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);
      const msg = ensureReplayAssistantMessage(
        sessionId,
        getReplayMessageId(update),
        created,
        getReplayAssistantMessageMetadata(sessionId, update),
      );
      msg.content.push({
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: rawInputToArguments(update.rawInput),
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: created ?? Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
      });
      break;
    }

    case "tool_call_update": {
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
        store.startAssistantStreamAfterIntervention(sessionId);
        break;
      }

      const messageId = ensureLiveAssistantMessage(
        sessionId,
        getChunkMessageId(update) ?? undefined,
      );

      if (update.content.type === "text" && "text" in update.content) {
        store.setStreamingMessageId(sessionId, messageId);
        store.updateStreamingText(sessionId, update.content.text);
      }
      break;
    }

    case "user_message_chunk": {
      if (isRunInterventionBoundary(update)) {
        store.startAssistantStreamAfterIntervention(sessionId);
      }
      break;
    }

    case "tool_call": {
      const messageId = ensureLiveAssistantMessage(sessionId);
      const identity = getToolCallIdentity(update);
      const chainSummary = getToolChainSummary(update);

      const toolRequest: ToolRequestContent = {
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: rawInputToArguments(update.rawInput),
        status: "in_progress",
        ...toolCallUpdatePatch(update),
        startedAt: Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
      };
      store.setStreamingMessageId(sessionId, messageId);
      store.appendToStreamingMessage(sessionId, toolRequest);
      break;
    }

    case "tool_call_update": {
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
      const snapshot = getModelConfigSnapshot(update);
      if (snapshot) {
        handleModelConfigSnapshot(sessionId, snapshot);
      }
      break;
    }

    case "usage_update": {
      const usage = update as SessionUpdate & { sessionUpdate: "usage_update" };

      useChatStore.getState().updateTokenState(sessionId, {
        accumulatedTotal: usage.used,
        contextLimit: usage.size,
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

function ensureLiveAssistantMessage(
  sessionId: string,
  preferredMessageId?: string | null,
): string {
  const store = useChatStore.getState();
  const existingStreamingMessageId = findStreamingMessageId(sessionId);
  const messages = store.messagesBySession[sessionId] ?? [];
  const activePreset = activeMessagePresets.get(sessionId);

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

  store.setPendingAssistantProvider(sessionId, null);
  store.setStreamingMessageId(sessionId, messageId);
  clearActiveMessageId(sessionId);

  return messageId;
}

export function clearMessageTracking(): void {
  activeMessagePresets.clear();
  clearReplayAssistantTracking();
  clearSkillReplayChips();
}

const handler: AcpNotificationHandler = {
  handleSessionNotification,
};

export default handler;
