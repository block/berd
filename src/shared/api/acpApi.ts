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
import { getClient } from "./acpConnection";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
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

export async function listProviders(): Promise<AcpProvider[]> {
  return getCuratedAgentProviders();
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
}: {
  cursor?: string | null;
} = {}): Promise<AcpSessionsPage> {
  const client = await getClient();
  const normalizedCursor = cursor?.trim() || null;
  // ACP session/list only standardizes cwd and cursor filters. Goose project
  // membership lives in _meta.projectId, so callers must paginate globally and
  // group by projectId client-side instead of using cwd as a proxy.
  const params: ListSessionsRequest = {
    _meta: LIST_SESSIONS_META,
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
  const result = await client.goose.GooseUnstableSessionImport({ data: json });
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
    modelId,
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
  });
  perfLog(
    `[perf:api] ${sid} setSessionConfigOption(${configId}=${value}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function setProvider(
  sessionId: string,
  providerId: string,
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
    providerId,
  });
  perfLog(
    `[perf:api] ${sid} setProvider(${providerId}→${wireProvider}) getClient=${(tCall - tClient).toFixed(1)}ms wire=${(performance.now() - tCall).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function updateWorkingDir(
  sessionId: string,
  workingDir: string,
): Promise<void> {
  const client = await getClient();
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

export async function newSession(
  workingDir: string,
  providerId?: string,
  projectId?: string,
  personaId?: string,
): Promise<NewSessionResponse> {
  const tClient = performance.now();
  const client = await getClient();
  const request: Parameters<typeof client.newSession>[0] = {
    cwd: workingDir,
    mcpServers: [],
  };

  const meta: Record<string, string> = {};
  if (providerId) meta.provider = toWireProviderId(providerId);
  if (projectId) meta.projectId = projectId;
  if (personaId) meta.personaId = personaId;
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
): Promise<PromptResponse> {
  const client = await getClient();
  return client.prompt({ sessionId, prompt: content, _meta: meta });
}

const UNKNOWN_EXPECTED_RUN_ID = "__goose_internal_unknown_active_run__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

export async function steerSession(
  sessionId: string,
  content: ContentBlock[],
  expectedRunId: string | null,
  meta?: Record<string, unknown>,
): Promise<string> {
  const client = await getClient();
  const steer = async (runId: string) => {
    const response = await client.extMethod("_goose/unstable/session/steer", {
      sessionId,
      prompt: content,
      expectedRunId: runId,
      ...(meta ? { _meta: meta } : {}),
    });
    return typeof response.runId === "string" ? response.runId : runId;
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
