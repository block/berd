import type { ContentBlock } from "@agentclientprotocol/sdk";
import * as directAcp from "./acpApi";
import type {
  AcpForkSessionOptions,
  AcpSessionInfo,
  AcpSessionsPage,
  AcpSteerResponse,
} from "./acpApi";
import * as sessionRegistry from "./acpSessionRegistry";
import type { AcpSessionExecutionSelection } from "./acpSessionRegistry";
import {
  getCatalogEntry,
  resolveAgentProviderCatalogId,
} from "@/features/providers/providerCatalog";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import {
  setActiveMessageId,
  clearActiveMessageId,
} from "./acpActiveMessageTracking";
import {
  searchSessions,
  type SessionSearchOptions,
  type SessionSearchTarget,
} from "./sessionSearch";
import {
  isGooseManagedProvider,
  preparePersonaHandoff,
  type PersonaHandoffClaim,
} from "./acpPersonaHandoff";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { resolveManagedGooseProviderSelection } from "@/shared/runtime-config/modelProviderPolicy";
import { getStyleGuidelinesPrompt } from "@/shared/preferences/styleGuidelinesPreference";
import { getBerdctlPreamble } from "@/features/berdctl/appPreamble";
import { INTERACTION_NORMS_PREAMBLE } from "@/shared/api/interactionNorms";
import { perfLog } from "@/shared/lib/perfLog";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

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
  /** Fires after ACP setup/client acquisition, immediately before transport. */
  onPromptDispatching?: () => void;
  /** Fires after ACP setup completes and the external prompt invocation starts. */
  onPromptDispatched?: () => void;
}

export interface AcpCreateSessionOptions {
  personaId?: string;
  projectId?: string;
  modelId?: string | null;
  deferProviderSetup?: boolean;
}

export interface AcpSessionConfigApplyOptions {
  forceConfigRefresh?: boolean;
  /** Model the caller will apply as part of the same session preparation. */
  modelId?: string | null;
  /** UI selection intent that owns any response snapshots. */
  requestId?: string;
}

export interface AcpCreateSessionResult {
  sessionId: string;
  configOptionsSnapshot: AcpSessionConfigSnapshots;
}

export type AcpDuplicateSessionOptions = AcpForkSessionOptions;

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

const BERD_INTERACTION_NORMS_SYSTEM_PROMPT_KEY = "berd_interaction_norms";
const BERD_APP_CONTEXT_SYSTEM_PROMPT_KEY = "berd_app_context";
const BERD_STYLE_GUIDELINES_SYSTEM_PROMPT_KEY = "berd_style_guidelines";
const LEGACY_STYLE_GUIDELINES_SYSTEM_PROMPT_KEY =
  "goose_internal_style_guidelines";

async function appendBerdStyleGuidelinesPrompt(
  sessionId: string,
  prompt: string,
): Promise<void> {
  // Clear the pre-rename app-owned key first so existing sessions do not keep
  // duplicate Additional Instructions under both goose-internal and berd keys.
  await directAcp.appendSessionSystemPrompt(
    sessionId,
    LEGACY_STYLE_GUIDELINES_SYSTEM_PROMPT_KEY,
    "",
  );
  await directAcp.appendSessionSystemPrompt(
    sessionId,
    BERD_STYLE_GUIDELINES_SYSTEM_PROMPT_KEY,
    prompt,
  );
}

/** Send a message to an ACP agent. Response streams via Tauri events. */
export function acpSendMessage(
  sessionId: string,
  prompt: string,
  options: AcpSendMessageOptions = {},
): Promise<void> {
  return sessionRegistry.runPreparedSessionPrompt(sessionId, (providerId) =>
    acpSendMessageNow(sessionId, prompt, providerId, options),
  );
}

async function acpSendMessageNow(
  sessionId: string,
  prompt: string,
  providerId: string,
  options: AcpSendMessageOptions,
): Promise<void> {
  const {
    systemPrompt,
    assistantPrompt,
    personaId,
    personaName,
    goose,
    images,
    onPromptDispatching,
    onPromptDispatched,
  } = options;
  const sid = sessionId.slice(0, 8);
  const tStart = performance.now();

  const resolvedProvider = resolveGooseSessionSelection(providerId).providerId;
  if (resolvedProvider !== providerId) {
    throw new Error(
      `Session provider ${providerId} is outside the managed Goose provider policy. Re-prepare the session before prompting.`,
    );
  }

  // Goose owns prompt assembly and accepts a real system prompt via its ACP
  // extension. External agent harnesses (Claude Code, Codex, ...) ignore that
  // method and expose no system-prompt channel, so we hand the persona off
  // in-band on the first prompt under that agent instead. See acpPersonaHandoff.
  const isGooseManaged = !providerId || isGooseManagedProvider(providerId);
  const berdctlPreamble = await getBerdctlPreamble();
  let personaHandoffClaim: PersonaHandoffClaim | null = null;
  if (isGooseManaged) {
    await appendBerdStyleGuidelinesPrompt(
      sessionId,
      getStyleGuidelinesPrompt(),
    );
    // App-level defaults with no off switch. Sent before user-authored
    // sections so the user's own content arrives after — and therefore
    // reads as — the override. See interactionNorms.ts.
    await directAcp.appendSessionSystemPrompt(
      sessionId,
      BERD_INTERACTION_NORMS_SYSTEM_PROMPT_KEY,
      INTERACTION_NORMS_PREAMBLE,
    );
    // Keyed and re-sent on every send (empty when berdctl is unreachable),
    // so availability changes self-correct on the next message.
    await directAcp.appendSessionSystemPrompt(
      sessionId,
      BERD_APP_CONTEXT_SYSTEM_PROMPT_KEY,
      berdctlPreamble ?? "",
    );
    await directAcp.appendSessionSystemPrompt(
      sessionId,
      "client_system_prompt",
      systemPrompt?.trim() ? systemPrompt : "",
    );
  } else {
    const appPreamble = [INTERACTION_NORMS_PREAMBLE, berdctlPreamble]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    personaHandoffClaim = preparePersonaHandoff(
      sessionId,
      providerId,
      systemPrompt,
      appPreamble,
    );
  }

  // Merge the persona handoff (when present) with any skill/builder assistant
  // prompt into a single assistant-audience block, persona first.
  const assistantPromptParts = [
    personaHandoffClaim?.preamble,
    assistantPrompt?.trim(),
  ].filter((part): part is string => Boolean(part?.trim()));
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
    const promptPromise = directAcp.prompt(
      sessionId,
      content,
      Object.keys(meta).length > 0 ? meta : undefined,
      {
        onPromptDispatching: () => {
          onPromptDispatching?.();
          personaHandoffClaim?.markDelivered();
        },
        onPromptDispatched,
      },
    );
    await promptPromise;
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
): Promise<AcpSteerResponse> {
  sessionRegistry.requireSessionInvocationSelection(sessionId);
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

function resolveGooseSessionSelection(
  providerId: string,
  modelId?: string | null,
): { providerId: string; modelId?: string } {
  if (modelId === "goose") {
    throw new Error(`Invalid model id: ${modelId}`);
  }
  const concreteModelId = normalizeConcreteModelId(modelId);
  // Agent harnesses are outside Goose model-provider policy. Everything else
  // is resolved from runtime policy directly; a missing model catalog entry
  // must not turn into an allowlist bypass while catalogs are still loading.
  if (
    providerId !== "goose" &&
    CURATED_PROVIDER_CATALOG_BY_ID.get(providerId)?.category === "agent"
  ) {
    return {
      providerId,
      ...(concreteModelId ? { modelId: concreteModelId } : {}),
    };
  }

  const runtimeConfigState = useRuntimeConfigStore.getState();
  if (runtimeConfigState.result.status === "unavailable") {
    throw new Error(
      `Goose provider policy is unavailable: ${runtimeConfigState.result.message}`,
    );
  }

  const requestedSelection = {
    providerId,
    ...(concreteModelId ? { modelId: concreteModelId } : {}),
  };
  const managedSelection = resolveManagedGooseProviderSelection(
    runtimeConfigState.config,
    requestedSelection,
  );
  if (!managedSelection) return requestedSelection;
  if (providerId === "goose") return managedSelection;
  if (managedSelection.providerId !== providerId) {
    throw new Error(
      `Provider ${providerId} is outside the managed Goose provider policy.`,
    );
  }

  // A concrete provider is renderer-owned. Policy may validate it, but must
  // not replace its provider or inject a different provider's default model.
  return requestedSelection;
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
  const selection = resolveGooseSessionSelection(providerId, options.modelId);
  const applyResolvedModel =
    Boolean(options.modelId) || selection.providerId !== providerId;
  const snapshots =
    applyResolvedModel && selection.modelId
      ? await sessionRegistry.configureSession(
          sessionId,
          selection.providerId,
          workingDir,
          selection.modelId,
          options,
        )
      : await sessionRegistry.prepareSession(
          sessionId,
          selection.providerId,
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
  const selection = resolveGooseSessionSelection(providerId, options.modelId);
  providerId = selection.providerId;
  options = { ...options, modelId: selection.modelId };
  // Only the "goose" sentinel should rely on backend defaults. Concrete
  // model providers must be sent even without a model so Goose does not try to
  // resolve a missing global GOOSE_PROVIDER.
  const deferProviderSetup =
    options.deferProviderSetup === true &&
    !options.modelId &&
    providerId === "goose";
  const response = await directAcp.newSession(workingDir, {
    providerId: deferProviderSetup ? undefined : providerId,
    projectId: options.projectId,
    personaId: options.personaId,
  });
  const sessionId = response.sessionId;
  let rollbackSessionRegistration: (() => void) | undefined;
  let configOptionsSnapshot = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("acpCreateSession newSession response", {
    sessionId: shortLogId(sessionId),
    providerId,
    requestedModelId: options.modelId ?? null,
    providerSetupDeferred: deferProviderSetup,
    hasReasoningEffortSnapshot: Boolean(configOptionsSnapshot.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      configOptionsSnapshot.reasoningEffort,
    ),
  });
  try {
    if (!deferProviderSetup) {
      const providerConfigSnapshot = await directAcp.setProvider(
        sessionId,
        providerId,
      );
      configOptionsSnapshot = providerConfigSnapshot;
      logReasoningEffortInfo("acpCreateSession setProvider complete", {
        sessionId: shortLogId(sessionId),
        providerId,
        requestedModelId: options.modelId ?? null,
        hasReasoningEffortSnapshot: Boolean(
          configOptionsSnapshot.reasoningEffort,
        ),
        ...reasoningEffortConfigLogFields(
          "reasoningEffort",
          configOptionsSnapshot.reasoningEffort,
        ),
      });
      rollbackSessionRegistration = sessionRegistry.registerPreparedSession(
        sessionId,
        providerId,
        workingDir,
        providerConfigSnapshot?.model?.modelId,
      );
    }
    if (options.modelId) {
      configOptionsSnapshot =
        (await sessionRegistry.applySessionModel(sessionId, options.modelId)) ??
        configOptionsSnapshot;
    }
    return { sessionId, configOptionsSnapshot };
  } catch (error) {
    rollbackSessionRegistration?.();
    try {
      await directAcp.archiveSession(sessionId);
    } catch (archiveError) {
      console.error(
        "Failed to archive ACP session after creation setup failed:",
        archiveError,
      );
    }
    throw error;
  }
}

export async function acpSetSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  return sessionRegistry.applySessionConfigOption(
    sessionId,
    configId,
    value,
    context,
  );
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

/**
 * A sweep's matches plus which of its targets were actually read. Callers need
 * the coverage split to avoid reporting an unreadable session as a searched one.
 */
export interface AcpSessionSearchSweep {
  results: AcpSessionSearchResult[];
  searchedIds: string[];
  failedIds: string[];
  /** Metadata of every session whose message content matched the query on the
   *  server — including sessions not among `targets`, so callers can surface
   *  matches beyond the sessions currently loaded in the renderer. Empty when
   *  nothing matched or no server-side discovery ran (short query). */
  matchedInfos: AcpSessionInfo[];
}

/** List one page of sessions known to the goose binary. */
export async function acpListSessionsPage({
  cursor,
  query,
}: {
  cursor?: string | null;
  query?: string | null;
} = {}): Promise<AcpSessionsPage> {
  return directAcp.listSessionsPage({ cursor, query });
}

/**
 * Search session content. A query that meets the content-search threshold is
 * discovered server-side (goose's `_meta.query` SQL filter over message text,
 * cursor-paginated) so the whole session store is covered; `targets` are then
 * export-swept for snippet/match-count enrichment and coverage. Below the
 * threshold no content search runs at all and the sweep is empty.
 */
export async function acpSearchSessions(
  query: string,
  targets: SessionSearchTarget[],
  options: SessionSearchOptions = {},
): Promise<AcpSessionSearchSweep> {
  return searchSessions(query, targets, options);
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
): Promise<AcpSessionExecutionSelection | undefined> {
  const effectiveWorkingDir = workingDir ?? "~";
  const sid = sessionId.slice(0, 8);
  const t0 = performance.now();
  logReasoningEffortInfo("acpLoadSession start", {
    sessionId: shortLogId(sessionId),
  });
  perfLog(`[perf:load] ${sid} acpLoadSession → client.loadSession`);
  const { response, isCurrent, executionSelection } =
    await sessionRegistry.loadSession(sessionId, effectiveWorkingDir);
  if (!isCurrent) {
    perfLog(
      `[perf:load] ${sid} dropped superseded load snapshot in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return undefined;
  }
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
  return executionSelection;
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
