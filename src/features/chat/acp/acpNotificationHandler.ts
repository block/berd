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
import { applyChatSessionConfigOptionsSnapshot } from "./sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import { getPreparedProviderId } from "@/shared/api/acpSessionRegistry";
import {
  appendExternalAcpTerminalOutput,
  finishExternalAcpTerminal,
  registerExternalAcpTerminal,
  requestOpenAcpTerminal,
} from "@/features/terminal/lib/acpTerminalManager";
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

const TERMINAL_AUTO_OPEN_DELAY_MS = 5_000;
const terminalAutoOpenTimers = new Map<string, number>();
const exitedExternalTerminals = new Set<string>();
const terminalIdsByToolCall = new Map<string, string>();
const terminalInfoByToolCall = new Map<
  string,
  { cwd: string; title: string }
>();
const replayTerminalToolCalls = new Set<string>();
const registeredExternalTerminals = new Set<string>();

function terminalSessionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}

function terminalToolCallKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
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

function terminalMetadata(update: SessionUpdate): Record<string, unknown> {
  const meta = (update as { _meta?: unknown })._meta;
  return isRecord(meta) ? meta : {};
}

function terminalOutputFromUpdate(update: SessionUpdate): {
  terminalId: string;
  data: string;
} | null {
  const meta = terminalMetadata(update);
  const output = isRecord(meta.terminal_output)
    ? meta.terminal_output
    : isRecord(meta.terminal_output_delta)
      ? meta.terminal_output_delta
      : null;
  if (!output) return null;
  const terminalId = output.terminal_id;
  const data = output.data;
  return typeof terminalId === "string" && typeof data === "string"
    ? { terminalId, data }
    : null;
}

function terminalExitFromUpdate(update: SessionUpdate): {
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
} | null {
  const exit = terminalMetadata(update).terminal_exit;
  if (!isRecord(exit) || typeof exit.terminal_id !== "string") return null;
  return {
    terminalId: exit.terminal_id,
    exitCode: typeof exit.exit_code === "number" ? exit.exit_code : null,
    signal: typeof exit.signal === "string" ? exit.signal : null,
  };
}

function terminalCwdFromUpdate(update: SessionUpdate): string | null {
  const info = terminalMetadata(update).terminal_info;
  return isRecord(info) && typeof info.cwd === "string" ? info.cwd : null;
}

type TerminalToolCallUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

function terminalReferenceFromUpdate(
  sessionId: string,
  update: TerminalToolCallUpdate,
  useKnownTerminal = false,
): string | undefined {
  let terminalId: string | undefined;
  const content = (update as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        isRecord(item) &&
        item.type === "terminal" &&
        typeof item.terminalId === "string"
      ) {
        terminalId = item.terminalId;
        break;
      }
    }
  }

  // Some ACP relays preserve Codex's terminal metadata but omit the terminal
  // content block. Recover the same id from the metadata in that case.
  const meta = terminalMetadata(update);
  const terminalInfo = meta.terminal_info;
  if (
    !terminalId &&
    isRecord(terminalInfo) &&
    typeof terminalInfo.terminal_id === "string"
  ) {
    terminalId = terminalInfo.terminal_id;
  }
  // Codex defines the terminal id as the command tool-call id. Some relay
  // versions omit both terminal metadata and kind=execute, so the prepared
  // provider identity is the trust boundary for its command-shaped fallback.
  // Other providers still require the ACP execute signal; rawInput alone is
  // never sufficient for an arbitrary tool.
  const providerId = getPreparedProviderId(sessionId)?.toLowerCase();
  const isCodexExecute =
    providerId?.includes("codex") &&
    update.sessionUpdate === "tool_call" &&
    isRecord(update.rawInput) &&
    typeof update.rawInput.command === "string";
  if (
    !terminalId &&
    (isCodexExecute ||
      (update.sessionUpdate === "tool_call" && update.kind === "execute"))
  ) {
    terminalId = update.toolCallId;
  }

  const key = terminalToolCallKey(sessionId, update.toolCallId);
  if (terminalId) {
    terminalIdsByToolCall.set(key, terminalId);
    return terminalId;
  }
  return useKnownTerminal ? terminalIdsByToolCall.get(key) : undefined;
}

function toolCallUpdatePatch(
  sessionId: string,
  update: TerminalToolCallUpdate,
): Pick<Partial<ToolRequestContent>, "toolKind" | "locations" | "terminalId"> {
  const toolKind = toolKindFromUpdate(update);
  const locations = locationsFromUpdate(update);
  const terminalId = terminalReferenceFromUpdate(sessionId, update);

  return {
    ...(toolKind ? { toolKind } : {}),
    ...(locations ? { locations } : {}),
    ...(terminalId ? { terminalId } : {}),
  };
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

function rememberTerminalInfo(
  sessionId: string,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
): void {
  const rawInput = isRecord(update.rawInput) ? update.rawInput : {};
  terminalInfoByToolCall.set(
    terminalToolCallKey(sessionId, update.toolCallId),
    {
      cwd:
        terminalCwdFromUpdate(update) ??
        (typeof rawInput.cwd === "string" ? rawInput.cwd : "~"),
      title:
        typeof rawInput.command === "string"
          ? rawInput.command
          : update.title || "Agent command",
    },
  );
}

function retainReplayTerminalState(
  sessionId: string,
  update: SessionUpdate,
): void {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return;
  }
  if (update.sessionUpdate === "tool_call") {
    rememberTerminalInfo(sessionId, update);
  }
  if (terminalReferenceFromUpdate(sessionId, update, true)) {
    replayTerminalToolCalls.add(
      terminalToolCallKey(sessionId, update.toolCallId),
    );
  }
}

function handleReplay(sessionId: string, update: SessionUpdate): void {
  // Replay builds display state only. Keep terminal correlation for a live
  // continuation, but never register/open historical processes while loading.
  retainReplayTerminalState(sessionId, update);

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
      msg.content.push({
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: rawInputToArguments(update.rawInput),
        status: "in_progress",
        ...toolCallUpdatePatch(sessionId, update),
        startedAt: created ?? Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
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
        const patch = toolCallUpdatePatch(sessionId, update);
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
                ...toolCallUpdatePatch(sessionId, update),
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

function syncExternalTerminal(sessionId: string, update: SessionUpdate): void {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return;
  }

  const toolCallKey = terminalToolCallKey(sessionId, update.toolCallId);
  if (update.sessionUpdate === "tool_call") {
    rememberTerminalInfo(sessionId, update);
  }

  const terminalId = terminalReferenceFromUpdate(sessionId, update, true);
  const info = terminalInfoByToolCall.get(toolCallKey);
  const terminalKey = terminalId
    ? terminalSessionKey(sessionId, terminalId)
    : undefined;
  const recoveredFromReplay = replayTerminalToolCalls.delete(toolCallKey);
  if (
    terminalId &&
    terminalKey &&
    info &&
    !registeredExternalTerminals.has(terminalKey)
  ) {
    // Mark before the async registration to prevent output and exit arriving in
    // the same tick from starting duplicate registrations.
    registeredExternalTerminals.add(terminalKey);
    void registerExternalAcpTerminal({ sessionId, terminalId, ...info })
      .then(() => {
        // Replayed commands are historical. A later live output/exit may need
        // to recreate their display, but must not auto-open it as a long-running
        // command that just started.
        if (recoveredFromReplay || exitedExternalTerminals.has(terminalKey)) {
          return;
        }

        // Keep short commands as lightweight tool rows. If the same command is
        // still running after this grace period, expose the persistent process
        // without stealing focus from the user's current work.
        if (terminalAutoOpenTimers.has(terminalKey)) return;
        const timer = window.setTimeout(() => {
          terminalAutoOpenTimers.delete(terminalKey);
          const toolRequest = useChatStore
            .getState()
            .messagesBySession[sessionId]?.flatMap((message) => message.content)
            .find(
              (content) =>
                content.type === "toolRequest" &&
                content.id === update.toolCallId &&
                content.terminalId === terminalId,
            );
          if (
            toolRequest?.type === "toolRequest" &&
            toolRequest.status === "in_progress"
          ) {
            requestOpenAcpTerminal(sessionId, terminalId, { automatic: true });
          }
        }, TERMINAL_AUTO_OPEN_DELAY_MS);
        terminalAutoOpenTimers.set(terminalKey, timer);
      })
      .catch((error) => {
        registeredExternalTerminals.delete(terminalKey);
        console.warn("Failed to register agent terminal", {
          sessionId,
          terminalId,
          error,
        });
      });
  }

  const output = terminalOutputFromUpdate(update);
  if (output) {
    void appendExternalAcpTerminalOutput(
      sessionId,
      output.terminalId,
      output.data,
    ).catch((error) => {
      console.warn("Failed to append agent terminal output", {
        sessionId,
        terminalId: output.terminalId,
        error,
      });
    });
  }

  const exit = terminalExitFromUpdate(update);
  if (exit) {
    const key = terminalSessionKey(sessionId, exit.terminalId);
    exitedExternalTerminals.add(key);
    const autoOpenTimer = terminalAutoOpenTimers.get(key);
    if (autoOpenTimer) {
      window.clearTimeout(autoOpenTimer);
      terminalAutoOpenTimers.delete(key);
    }
    void finishExternalAcpTerminal(sessionId, exit.terminalId, {
      exitCode: exit.exitCode,
      signal: exit.signal,
    }).catch((error) => {
      console.warn("Failed to finish agent terminal", {
        sessionId,
        terminalId: exit.terminalId,
        error,
      });
    });
  }
}

function handleLive(sessionId: string, update: SessionUpdate): void {
  const store = useChatStore.getState();
  syncExternalTerminal(sessionId, update);

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

      const toolRequest: ToolRequestContent = {
        type: "toolRequest",
        id: update.toolCallId,
        name: update.title,
        ...identity,
        arguments: rawInputToArguments(update.rawInput),
        status: "in_progress",
        ...toolCallUpdatePatch(sessionId, update),
        startedAt: Date.now(),
        ...(chainSummary ? { chainSummary } : {}),
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

      const patch = toolCallUpdatePatch(sessionId, update);
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
                  ...toolCallUpdatePatch(sessionId, update),
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
  for (const timer of terminalAutoOpenTimers.values()) {
    window.clearTimeout(timer);
  }
  terminalAutoOpenTimers.clear();
  exitedExternalTerminals.clear();
  terminalIdsByToolCall.clear();
  terminalInfoByToolCall.clear();
  replayTerminalToolCalls.clear();
  registeredExternalTerminals.clear();
}

const handler: AcpNotificationHandler = {
  handleSessionNotification,
  handleConnectionClosed: clearMessageTracking,
};

export default handler;
