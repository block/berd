import type { ContentBlock } from "@agentclientprotocol/sdk";
import * as directAcp from "./acpApi";
import type {
  AcpForkSessionOptions,
  AcpSessionInfo,
  AcpSessionsPage,
} from "./acpApi";
import * as sessionRegistry from "./acpSessionRegistry";
import {
  getCatalogEntry,
  resolveAgentProviderCatalogId,
} from "@/features/providers/providerCatalog";
import {
  setActiveMessageId,
  clearActiveMessageId,
} from "./acpActiveMessageTracking";
import { searchSessionsViaExports } from "./sessionSearch";
import {
  claimPersonaHandoff,
  isGooseManagedProvider,
} from "./acpPersonaHandoff";
import { GOOSE_STYLE_GUIDELINES_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import { perfLog } from "@/shared/lib/perfLog";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";

export interface AcpProvider {
  id: string;
  label: string;
}

export interface AcpSendMessageOptions {
  systemPrompt?: string;
  assistantPrompt?: string;
  personaId?: string;
  personaName?: string;
  goose?: Record<string, unknown>;
  /** Image attachments as [base64Data, mimeType] pairs. */
  images?: [string, string][];
}

export interface AcpCreateSessionOptions {
  personaId?: string;
  projectId?: string;
  modelId?: string | null;
}

export interface AcpSessionConfigApplyOptions {
  forceConfigRefresh?: boolean;
}

export interface AcpCreateSessionResult {
  sessionId: string;
  configOptionsSnapshot: AcpSessionConfigSnapshots;
}

export type AcpDuplicateSessionOptions = AcpForkSessionOptions;

function mergeSessionConfigSnapshots(
  base: AcpSessionConfigSnapshots,
  next?: AcpSessionConfigSnapshots,
): AcpSessionConfigSnapshots {
  if (!next) {
    return base;
  }
  return {
    model: next.model ?? base.model,
    reasoningEffort: next.reasoningEffort ?? base.reasoningEffort,
  };
}

/** Discover ACP providers installed on the system. */
export async function discoverAcpProviders(): Promise<AcpProvider[]> {
  const providers = await directAcp.listProviders();
  return resolveProvidersCatalog(providers);
}

function resolveProvidersCatalog(providers: AcpProvider[]): AcpProvider[] {
  const seen = new Set<string>();

  return providers
    .map((provider) => {
      const catalogId = resolveAgentProviderCatalogId(
        provider.id,
        provider.label,
      );
      const resolvedId = catalogId ?? provider.id;
      if (seen.has(resolvedId)) {
        return null;
      }
      seen.add(resolvedId);
      return {
        id: resolvedId,
        label: getCatalogEntry(resolvedId)?.displayName ?? provider.label,
      };
    })
    .filter((provider): provider is AcpProvider => provider !== null);
}

function getEnabledGooseStyleGuidelinesPrompt(): string | null {
  const experiment = getExperiment(GOOSE_STYLE_GUIDELINES_EXPERIMENT_ID);
  if (!experiment?.enabled) return null;

  const prompt = experiment.config.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

/** Send a message to an ACP agent. Response streams via Tauri events. */
export async function acpSendMessage(
  sessionId: string,
  prompt: string,
  options: AcpSendMessageOptions = {},
): Promise<void> {
  const {
    systemPrompt,
    assistantPrompt,
    personaId,
    personaName,
    goose,
    images,
  } = options;
  const sid = sessionId.slice(0, 8);
  const tStart = performance.now();

  if (!sessionRegistry.isSessionPrepared(sessionId)) {
    throw new Error("Session not prepared. Call acpPrepareSession first.");
  }

  const providerId = sessionRegistry.getPreparedProviderId(sessionId);

  // Goose owns prompt assembly and accepts a real system prompt via its ACP
  // extension. External agent harnesses (Claude Code, Codex, ...) ignore that
  // method and expose no system-prompt channel, so we hand the persona off
  // in-band on the first prompt under that agent instead. See acpPersonaHandoff.
  const isGooseManaged = !providerId || isGooseManagedProvider(providerId);
  let personaHandoff: string | null = null;
  if (isGooseManaged) {
    const styleGuidelinesPrompt = getEnabledGooseStyleGuidelinesPrompt();
    if (styleGuidelinesPrompt) {
      await directAcp.appendSessionSystemPrompt(
        sessionId,
        "goose_internal_style_guidelines",
        styleGuidelinesPrompt,
      );
    }
    await directAcp.appendSessionSystemPrompt(
      sessionId,
      "client_system_prompt",
      systemPrompt?.trim() ? systemPrompt : "",
    );
  } else {
    personaHandoff = claimPersonaHandoff(sessionId, providerId, systemPrompt);
  }

  // Merge the persona handoff (when present) with any skill/builder assistant
  // prompt into a single assistant-audience block, persona first.
  const assistantPromptParts = [personaHandoff, assistantPrompt?.trim()].filter(
    (part): part is string => Boolean(part?.trim()),
  );
  const mergedAssistantPrompt =
    assistantPromptParts.length > 0
      ? assistantPromptParts.join("\n\n")
      : undefined;

  const content: ContentBlock[] = [];
  if (mergedAssistantPrompt) {
    content.push({
      type: "text",
      text: mergedAssistantPrompt,
      annotations: { audience: ["assistant"] },
    });
  }
  content.push({ type: "text", text: prompt });
  if (images) {
    for (const [data, mimeType] of images) {
      content.push({ type: "image", data, mimeType } as ContentBlock);
    }
  }

  const messageId = crypto.randomUUID();
  setActiveMessageId(
    sessionId,
    messageId,
    personaId
      ? {
          personaId,
          ...(personaName ? { personaName } : {}),
        }
      : undefined,
  );

  perfLog(
    `[perf:send] ${sid} acpSendMessage → prompt(len=${prompt.length}, imgs=${images?.length ?? 0})`,
  );
  const tPrompt = performance.now();
  const meta: Record<string, unknown> = {};
  if (personaId) meta.personaId = personaId;
  if (goose && Object.keys(goose).length > 0) meta.goose = goose;
  try {
    await directAcp.prompt(
      sessionId,
      content,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
    const tDone = performance.now();
    perfLog(
      `[perf:send] ${sid} prompt() resolved in ${(tDone - tPrompt).toFixed(1)}ms (total acpSendMessage ${(tDone - tStart).toFixed(1)}ms)`,
    );
  } finally {
    clearActiveMessageId(sessionId);
  }
}

/** Add context to the active ACP run without cancelling or starting a new turn. */
export async function acpSteerMessage(
  sessionId: string,
  expectedRunId: string | null,
  prompt: string,
  options: Pick<
    AcpSendMessageOptions,
    "assistantPrompt" | "goose" | "images"
  > = {},
): Promise<string> {
  const { assistantPrompt, goose, images } = options;
  const content: ContentBlock[] = [];
  const assistantText = assistantPrompt?.trim();
  if (assistantText) {
    content.push({
      type: "text",
      text: assistantText,
      annotations: { audience: ["assistant"] },
    });
  }
  content.push({ type: "text", text: prompt });
  if (images) {
    for (const [data, mimeType] of images) {
      content.push({ type: "image", data, mimeType } as ContentBlock);
    }
  }

  return directAcp.steerSession(
    sessionId,
    content,
    expectedRunId,
    goose && Object.keys(goose).length > 0 ? { goose } : undefined,
  );
}

/** Prepare or warm an ACP session ahead of the first prompt. */
export async function acpPrepareSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: AcpSessionConfigApplyOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const t0 = performance.now();
  perfLog(
    `[perf:prepare] ${sid} acpPrepareSession start (provider=${providerId})`,
  );
  const snapshots = await sessionRegistry.prepareSession(
    sessionId,
    providerId,
    workingDir,
    options,
  );
  perfLog(
    `[perf:prepare] ${sid} acpPrepareSession done in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function acpCreateSession(
  providerId: string,
  workingDir: string,
  options: AcpCreateSessionOptions = {},
): Promise<AcpCreateSessionResult> {
  const response = await directAcp.newSession(
    workingDir,
    providerId,
    options.projectId,
    options.personaId,
  );
  const sessionId = response.sessionId;
  let configOptionsSnapshot = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("acpCreateSession newSession response", {
    sessionId: shortLogId(sessionId),
    providerId,
    requestedModelId: options.modelId ?? null,
    hasReasoningEffortSnapshot: Boolean(configOptionsSnapshot.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      configOptionsSnapshot.reasoningEffort,
    ),
  });
  configOptionsSnapshot = mergeSessionConfigSnapshots(
    configOptionsSnapshot,
    await directAcp.setProvider(sessionId, providerId),
  );
  logReasoningEffortInfo("acpCreateSession setProvider complete", {
    sessionId: shortLogId(sessionId),
    providerId,
    requestedModelId: options.modelId ?? null,
    hasReasoningEffortSnapshot: Boolean(configOptionsSnapshot.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      configOptionsSnapshot.reasoningEffort,
    ),
  });
  sessionRegistry.registerPreparedSession(sessionId, providerId, workingDir);
  if (options.modelId) {
    configOptionsSnapshot = mergeSessionConfigSnapshots(
      configOptionsSnapshot,
      await sessionRegistry.applySessionModel(sessionId, options.modelId),
    );
  }
  return { sessionId, configOptionsSnapshot };
}

export async function acpSetModel(
  sessionId: string,
  modelId: string,
  options: AcpSessionConfigApplyOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  // Routed through the registry so repeat applies of the unchanged model are
  // not sent over the wire (the backend rebuilds the provider on every set).
  return sessionRegistry.applySessionModel(sessionId, modelId, options);
}

export async function acpSetSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<AcpSessionConfigSnapshots> {
  return directAcp.setSessionConfigOption(sessionId, configId, value);
}

export type { AcpSessionInfo, AcpSessionsPage };

export async function acpGetSessionInfo(
  sessionId: string,
): Promise<AcpSessionInfo> {
  return directAcp.getSessionInfo(sessionId);
}

export interface AcpSessionSearchResult {
  sessionId: string;
  snippet: string;
  messageId: string;
  messageRole?: "user" | "assistant" | "system";
  matchCount: number;
}

/** List one page of sessions known to the goose binary. */
export async function acpListSessionsPage({
  cursor,
}: {
  cursor?: string | null;
} = {}): Promise<AcpSessionsPage> {
  return directAcp.listSessionsPage({ cursor });
}

export async function acpSearchSessions(
  query: string,
  sessionIds: string[],
): Promise<AcpSessionSearchResult[]> {
  return searchSessionsViaExports(query, sessionIds);
}

/**
 * Load an existing session from the goose binary.
 *
 * This triggers message replay via SessionNotification events that the
 * notification handler picks up automatically.
 */
export async function acpLoadSession(
  sessionId: string,
  workingDir?: string,
): Promise<void> {
  const effectiveWorkingDir = workingDir ?? "~";
  const sid = sessionId.slice(0, 8);
  const t0 = performance.now();
  logReasoningEffortInfo("acpLoadSession start", {
    sessionId: shortLogId(sessionId),
  });
  const rollbackSessionRegistration = sessionRegistry.registerPreparedSession(
    sessionId,
    "goose",
    effectiveWorkingDir,
  );
  try {
    perfLog(`[perf:load] ${sid} acpLoadSession → client.loadSession`);
    const response = await directAcp.loadSession(
      sessionId,
      effectiveWorkingDir,
    );
    const snapshots = readSessionConfigOptionsSnapshots(response);
    logReasoningEffortInfo("acpLoadSession response", {
      sessionId: shortLogId(sessionId),
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
      `[perf:load] ${sid} client.loadSession resolved in ${(performance.now() - t0).toFixed(1)}ms`,
    );
  } catch (error) {
    rollbackSessionRegistration();
    throw error;
  }
}

/** Export a session as JSON via the goose binary. */
export async function acpExportSession(sessionId: string): Promise<string> {
  return directAcp.exportSession(sessionId);
}

/** Import a session from JSON via the goose binary. Returns new session metadata. */
export async function acpImportSession(json: string): Promise<AcpSessionInfo> {
  return directAcp.importSession(json);
}

/** Duplicate a session via ACP's fork method. Returns new session metadata. */
export async function acpDuplicateSession(
  sessionId: string,
  workingDir: string,
  duplicateTitle?: string,
  options?: AcpDuplicateSessionOptions,
): Promise<AcpSessionInfo> {
  const session = await directAcp.forkSession(sessionId, workingDir, options);
  const normalizedTitle = duplicateTitle?.trim();
  if (!normalizedTitle) {
    return session;
  }

  try {
    await directAcp.renameSession(session.sessionId, normalizedTitle);
    // forkSession returns a pre-rename snapshot (title: null); reflect the
    // applied title so callers can render the fork without waiting for a
    // session-list refresh.
    return { ...session, title: normalizedTitle };
  } catch (error) {
    console.error("Failed to rename duplicated session:", error);
  }

  return session;
}

/** Cancel an in-progress ACP session so the backend stops streaming. */
export async function acpCancelSession(sessionId: string): Promise<boolean> {
  await directAcp.cancelSession(sessionId);
  return true;
}
