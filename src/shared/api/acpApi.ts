import type {
  ContentBlock,
  ForkSessionRequest,
  NewSessionResponse,
  LoadSessionResponse,
  ListSessionsRequest,
  PromptResponse,
  SessionInfo,
} from "@agentclientprotocol/sdk";
import { messageSnippet } from "@/features/chat/lib/messageSnippet";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import { toWireProviderId } from "./acpPersonaHandoff";
import { getClient, interceptSessionNotifications } from "./acpConnection";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import { perfLog } from "@/shared/lib/perfLog";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";

export interface AcpProvider {
  id: string;
  label: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  userSetName: boolean;
  messageCount: number;
  subtitle: string | null;
  workingDir: string | null;
  projectId?: string | null;
  providerId: string | null;
  modelId: string | null;
  personaId: string | null;
  activeRunId?: string | null;
}

export interface AcpSessionsPage {
  sessions: AcpSessionInfo[];
  nextCursor: string | null;
}

export const DEFAULT_PROVIDER: AcpProvider = {
  id: "goose",
  label: "Goose (Default)",
};

const LIST_SESSIONS_META = {
  goose: {
    includeLastMessageSnippet: true,
  },
} satisfies NonNullable<ListSessionsRequest["_meta"]>;

/** `_meta` for a keyword-filtered session/list: goose reads top-level
 *  `_meta.query` as a whitespace-split, case-insensitive keyword OR over
 *  message text, so discovery runs server-side over the whole session store
 *  instead of only the sessions the renderer has loaded. Case folding is
 *  SQLite `LOWER()` — ASCII-only, so "CAFÉ" will not match a query of "café";
 *  a Unicode-aware collation belongs to goose, not this client. */
function listSessionsMeta(query: string): ListSessionsRequest["_meta"] {
  return { ...LIST_SESSIONS_META, query };
}

export async function listProviders(): Promise<AcpProvider[]> {
  return getCuratedAgentProviders();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapLastMessageSnippet(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return messageSnippet(value);
}

function metaString(
  meta: SessionInfo["_meta"] | null | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  return typeof value === "string" ? value : null;
}

function metaNumber(
  meta: SessionInfo["_meta"] | null | undefined,
  key: string,
): number | null {
  const value = meta?.[key];
  return typeof value === "number" ? value : null;
}

function mapSessionInfo(info: SessionInfo): AcpSessionInfo {
  const gooseMeta = isRecord(info._meta?.goose) ? info._meta.goose : null;
  const activeRunValue =
    gooseMeta && "activeRunId" in gooseMeta ? gooseMeta.activeRunId : undefined;
  const activeRunId =
    typeof activeRunValue === "string" || activeRunValue === null
      ? activeRunValue
      : undefined;

  return {
    sessionId: info.sessionId,
    title: info.title ?? null,
    updatedAt: info.updatedAt ?? null,
    createdAt: metaString(info._meta, "createdAt"),
    lastMessageAt: metaString(info._meta, "lastMessageAt"),
    archivedAt: metaString(info._meta, "archivedAt"),
    userSetName: info._meta?.userSetName === true,
    messageCount: metaNumber(info._meta, "messageCount") ?? 0,
    subtitle: mapLastMessageSnippet(info._meta?.lastMessageSnippet),
    workingDir: info.cwd ?? null,
    projectId: metaString(info._meta, "projectId"),
    providerId: metaString(info._meta, "providerId"),
    modelId: metaString(info._meta, "modelId"),
    personaId: metaString(info._meta, "personaId"),
    ...(activeRunId !== undefined ? { activeRunId } : {}),
  };
}

export async function getSessionInfo(
  sessionId: string,
): Promise<AcpSessionInfo> {
  const client = await getClient();
  const result = await client.goose.GooseUnstableSessionInfo({ sessionId });
  return mapSessionInfo(result.session as unknown as SessionInfo);
}

export async function listSessionsPage({
  cursor,
  query,
}: {
  cursor?: string | null;
  /** Keyword filter for goose's server-side message-content search
   *  (`_meta.query`). Only set when searching; omit for plain listing. */
  query?: string | null;
} = {}): Promise<AcpSessionsPage> {
  const client = await getClient();
  const normalizedCursor = cursor?.trim() || null;
  const normalizedQuery = query?.trim() || null;
  // ACP session/list only standardizes cwd and cursor filters. Goose project
  // membership lives in _meta.projectId, so callers must paginate globally and
  // group by projectId client-side instead of using cwd as a proxy.
  const params: ListSessionsRequest = {
    _meta: normalizedQuery
      ? listSessionsMeta(normalizedQuery)
      : LIST_SESSIONS_META,
  };
  if (normalizedCursor != null) {
    params.cursor = normalizedCursor;
  }

  const response = await client.listSessions(params);
  return {
    sessions: response.sessions.map(mapSessionInfo),
    nextCursor: response.nextCursor?.trim() || null,
  };
}

export async function exportSession(sessionId: string): Promise<string> {
  const client = await getClient();
  const result = await client.goose.GooseUnstableSessionExport({ sessionId });
  // biome-ignore lint/suspicious/noExplicitAny: SDK doesn't expose data field on export result
  return (result as any).data;
}

export async function importSession(json: string): Promise<AcpSessionInfo> {
  const client = await getClient();
  const result = await client.goose.GooseUnstableSessionImport({
    input: json,
    source: "json",
  });
  return result as unknown as AcpSessionInfo;
}

export interface AcpForkSessionOptions {
  conversationBefore?: number;
}

function isValidConversationBefore(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export async function forkSession(
  sessionId: string,
  workingDir: string,
  options: AcpForkSessionOptions = {},
): Promise<AcpSessionInfo> {
  const client = await getClient();
  const params: ForkSessionRequest = {
    sessionId,
    cwd: workingDir,
    mcpServers: [],
  };
  if (isValidConversationBefore(options.conversationBefore)) {
    params._meta = { conversationBefore: options.conversationBefore };
  }

  const response = await client.unstable_forkSession(params);
  return {
    sessionId: response.sessionId,
    title: null,
    updatedAt: null,
    createdAt: metaString(response._meta, "createdAt"),
    lastMessageAt: metaString(response._meta, "lastMessageAt"),
    archivedAt: metaString(response._meta, "archivedAt"),
    userSetName: response._meta?.userSetName === true,
    messageCount: metaNumber(response._meta, "messageCount") ?? 0,
    subtitle: mapLastMessageSnippet(response._meta?.lastMessageSnippet),
    workingDir,
    projectId: metaString(response._meta, "projectId"),
    providerId: metaString(response._meta, "providerId"),
    modelId: metaString(response._meta, "modelId"),
    personaId: null,
  };
}

export async function setModel(
  sessionId: string,
  modelId: string,
  context: { providerId?: string; requestId?: string } = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId: "model",
    value: modelId,
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setModel response", {
    sessionId: shortLogId(sessionId),
    modelId,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
    modelId: snapshots.model?.modelId ?? modelId,
  });
  perfLog(
    `[perf:api] ${sid} setModel(${modelId}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId,
    value,
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setSessionConfigOption response", {
    sessionId: shortLogId(sessionId),
    configId,
    requestedValue: value,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
  });
  perfLog(
    `[perf:api] ${sid} setSessionConfigOption(${configId}=${value}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function setProvider(
  sessionId: string,
  providerId: string,
  context: { requestId?: string } = {},
): Promise<AcpSessionConfigSnapshots> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const wireProvider = toWireProviderId(providerId);
  const tCall = performance.now();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId: "provider",
    value: wireProvider,
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("setProvider response", {
    sessionId: shortLogId(sessionId),
    providerId,
    wireProvider,
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
    ...context,
    providerId,
    modelId: snapshots.model?.modelId,
  });
  perfLog(
    `[perf:api] ${sid} setProvider(${providerId}→${wireProvider}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function updateWorkingDir(
  sessionId: string,
  workingDir: string,
  beforeUpdate?: () => void,
): Promise<void> {
  const client = await getClient();
  // Run guards after the asynchronous client lookup and synchronously before
  // dispatching the mutation. This lets callers close local state races
  // without exposing the ACP client or duplicating the wire operation.
  beforeUpdate?.();
  await client.goose.GooseUnstableSessionWorkingDirUpdate({
    sessionId,
    workingDir,
  });
}

export async function setSessionSystemPrompt(
  sessionId: string,
  text: string,
): Promise<void> {
  const client = await getClient();
  await client.extMethod("_goose/unstable/session/system-prompt/set", {
    sessionId,
    mode: "set",
    text,
  });
}

export async function appendSessionSystemPrompt(
  sessionId: string,
  key: string,
  text: string,
): Promise<void> {
  const client = await getClient();
  await client.extMethod("_goose/unstable/session/system-prompt/set", {
    sessionId,
    mode: "append",
    key,
    text,
  });
}

export async function updateSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSessionProjectUpdate({
    sessionId,
    projectId,
  });
}

export async function archiveSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSessionArchive({ sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.extMethod("session/delete", { sessionId });
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSessionUnarchive({ sessionId });
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSessionRename({ sessionId, title });
}

export async function cancelSession(sessionId: string): Promise<void> {
  const client = await getClient();
  await client.cancel({ sessionId });
}

export interface NewSessionOptions {
  providerId?: string;
  projectId?: string;
  personaId?: string;
  hidden?: boolean;
}

export async function newSession(
  workingDir: string,
  options: NewSessionOptions = {},
): Promise<NewSessionResponse> {
  const { providerId, projectId, personaId, hidden } = options;
  const tClient = performance.now();
  const client = await getClient();
  const request: Parameters<typeof client.newSession>[0] = {
    cwd: workingDir,
    mcpServers: [],
  };

  const meta: Record<string, string | boolean> = {};
  if (providerId) meta.provider = toWireProviderId(providerId);
  if (projectId) meta.projectId = projectId;
  if (personaId) meta.personaId = personaId;
  if (hidden) meta.hidden = true;
  if (Object.keys(meta).length > 0) request._meta = meta;

  const tCall = performance.now();
  const response = await client.newSession(request);
  const sid = response.sessionId.slice(0, 8);
  perfLog(
    `[perf:api] ${sid} newSession getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return response;
}

export async function loadSession(
  sessionId: string,
  workingDir: string,
): Promise<LoadSessionResponse> {
  const sid = sessionId.slice(0, 8);
  const tClient = performance.now();
  const client = await getClient();
  const tCall = performance.now();
  const response = await client.loadSession({
    sessionId,
    cwd: workingDir,
    mcpServers: [],
  });
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("loadSession response", {
    sessionId: shortLogId(sessionId),
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  perfLog(
    `[perf:api] ${sid} loadSession getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return response;
}

export async function prompt(
  sessionId: string,
  content: ContentBlock[],
  meta?: Record<string, unknown>,
  callbacks: {
    onPromptDispatching?: () => void;
    onPromptDispatched?: () => void;
  } = {},
): Promise<PromptResponse> {
  const client = await getClient();
  callbacks.onPromptDispatching?.();
  const promptPromise = client.prompt({
    sessionId,
    prompt: content,
    _meta: meta,
  });
  callbacks.onPromptDispatched?.();
  return promptPromise;
}

/**
 * Runs a prompt in a private/background session and returns its streamed text.
 * Notifications for that session are consumed here instead of entering the
 * visible chat store.
 */
export async function promptForText(
  sessionId: string,
  content: ContentBlock[],
  timeoutMs: number,
): Promise<string | null> {
  const textChunks: string[] = [];
  let didTimeOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const stopIntercepting = interceptSessionNotifications((notification) => {
    if (notification.sessionId !== sessionId) {
      return false;
    }

    const { update } = notification;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      textChunks.push(update.content.text);
    }
    return true;
  });

  try {
    const promptCompleted = prompt(sessionId, content).then(() => true);
    const completed = await Promise.race([
      promptCompleted,
      new Promise<false>((resolve) => {
        timeoutId = setTimeout(() => {
          didTimeOut = true;
          resolve(false);
        }, timeoutMs);
      }),
    ]);

    if (!completed) {
      return null;
    }

    return textChunks.join("").trim() || null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (didTimeOut) {
      try {
        await cancelSession(sessionId);
      } catch {
        // Best-effort cancellation; the caller still owns session cleanup.
      }
    }
    stopIntercepting();
  }
}

const UNKNOWN_EXPECTED_RUN_ID = "__berd_unknown_active_run__";

function extractActualRunId(error: unknown): string | null {
  if (!isRecord(error) || !("data" in error)) {
    return null;
  }

  const data = error.data;
  if (isRecord(data) && typeof data.actualRunId === "string") {
    return data.actualRunId;
  }

  const message =
    typeof data === "string"
      ? data
      : isRecord(data) && typeof data.message === "string"
        ? data.message
        : "";
  const match = message.match(/found `([^`]+)`/);
  return match?.[1] ?? null;
}

export interface AcpSteerResponse {
  runId: string;
  messageId: string;
}

export async function steerSession(
  sessionId: string,
  content: ContentBlock[],
  expectedRunId: string | null,
  meta?: Record<string, unknown>,
): Promise<AcpSteerResponse> {
  const client = await getClient();
  const steer = async (runId: string): Promise<AcpSteerResponse> => {
    const response = await client.extMethod("_goose/unstable/session/steer", {
      sessionId,
      prompt: content,
      expectedRunId: runId,
      ...(meta ? { _meta: meta } : {}),
    });
    if (
      typeof response.runId !== "string" ||
      typeof response.messageId !== "string"
    ) {
      throw new Error("Steer response is missing runId or messageId");
    }
    return { runId: response.runId, messageId: response.messageId };
  };

  try {
    return await steer(expectedRunId ?? UNKNOWN_EXPECTED_RUN_ID);
  } catch (error) {
    const actualRunId = extractActualRunId(error);
    if (actualRunId && actualRunId !== expectedRunId) {
      return steer(actualRunId);
    }
    throw error;
  }
}
