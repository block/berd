import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { removeAgentBuilderSkillDraft } from "@/features/chat/lib/agentBuilderSkill";
import { getTextContent } from "@/shared/types/messages";
import {
  getStoredProvider,
  useAgentStore,
} from "@/features/agents/stores/agentStore";
import {
  getStoredModelPreference,
  getStoredModelPreferenceForProvider,
} from "@/features/chat/lib/modelPreferences";
import {
  getDefaultGooseModelId,
  getDefaultGooseModelProviderId,
} from "@/features/runtime-config/defaults";
import {
  createDraftAgentSource,
  deleteIfFreshPlaceholderDraft,
  discardAgentBuilderSource,
  findAgentBuilderSource,
  listAgentBuilderSources,
  promoteAgentBuilderDraftSource,
  readFreshAgentSource,
  type DraftAgentDefaults,
} from "./agentBuilderSourceLifecycle";
import type { AgentSourceEntry } from "@/shared/api/agents";
import {
  deriveSlug,
  fileStem,
  isEmptyPlaceholderDraft,
} from "./agentBuilderIdentity";
export {
  deriveSlug,
  fileStem,
  isEmptyPlaceholderDraft,
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
  PLACEHOLDER_AGENT_DESCRIPTION,
  PLACEHOLDER_AGENT_NAME,
  placeholderAgentName,
} from "./agentBuilderIdentity";

interface StartAgentBuilderSessionArgs {
  path?: string;
  slug?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface StartAgentBuilderSessionDeps {
  createNewTab: (
    title?: string,
    options?: { activate?: boolean },
  ) => MaybePromise<{ id: string }>;
  closeSession: (sessionId: string) => MaybePromise<void>;
  navigateChat: (sessionId: string) => MaybePromise<void>;
}

interface CloseSessionDeps {
  closeSession?: (sessionId: string) => MaybePromise<void>;
}

const localEditSessionIds = new Set<string>();
const localSaveHandlersBySessionId = new Map<
  string,
  () => MaybePromise<boolean>
>();
const AGENT_BUILDER_MENTION_INVOCATION = /^@agent-builder\s*$/i;

export function setAgentBuilderSessionLocalEdits(
  sessionId: string,
  hasLocalEdits: boolean,
): void {
  if (hasLocalEdits) {
    localEditSessionIds.add(sessionId);
    return;
  }

  localEditSessionIds.delete(sessionId);
}

export function setAgentBuilderSessionSaveHandler(
  sessionId: string,
  saveHandler: (() => MaybePromise<boolean>) | null,
): void {
  if (saveHandler) {
    localSaveHandlersBySessionId.set(sessionId, saveHandler);
    return;
  }

  localSaveHandlersBySessionId.delete(sessionId);
}

export async function saveDraftAgentSession(sessionId: string): Promise<void> {
  const saveLocalEdits = localSaveHandlersBySessionId.get(sessionId);
  if (saveLocalEdits) {
    const saved = await saveLocalEdits();
    if (!saved) {
      throw new Error("Failed to save local agent draft edits.");
    }
  }

  const source = await findCurrentBuilderSource(sessionId);
  if (source?.properties?.draft === true) {
    const freshSource = await readFreshAgentSource(source.path, source).catch(
      () => source,
    );
    const slug = fileStem(freshSource.path) || deriveSlug(freshSource.name);
    useChatSessionStore.getState().patchSession(sessionId, {
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: freshSource.path,
      targetAgentSlug: slug,
      targetAgentDraftState: null,
      targetAgentDraftSaved: true,
      updatedAt: new Date().toISOString(),
    });
  } else {
    useChatSessionStore.getState().patchSession(sessionId, {
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentDraftSaved: true,
      updatedAt: new Date().toISOString(),
    });
  }

  setAgentBuilderSessionLocalEdits(sessionId, false);
}

export async function startAgentBuilderSession(
  { path, slug }: StartAgentBuilderSessionArgs = {},
  deps: StartAgentBuilderSessionDeps,
): Promise<string> {
  if (path || slug) {
    const existing = findLiveBuilderSession({ path, slug });
    if (existing) {
      useChatSessionStore.getState().patchSession(existing.id, {
        agentBuilderOpen: true,
        agentBuilderChatStartCollapsed: false,
      });
      await deps.navigateChat(existing.id);
      return existing.id;
    }
  }

  if (path || slug) {
    const session = await deps.createNewTab("New agent", { activate: false });
    const sessionId = session.id;
    try {
      const target = await resolveExistingAgentTarget({ path, slug });
      useChatSessionStore.getState().patchSession(sessionId, {
        intent: "build-agent",
        agentBuilderOpen: true,
        targetAgentPath: target.path,
        targetAgentSlug: target.slug,
        targetAgentDraftState: null,
        targetAgentDraftSaved: false,
        agentBuilderChatStartCollapsed: false,
      });

      await deps.navigateChat(sessionId);
      return sessionId;
    } catch (error) {
      await deps.closeSession(sessionId);
      throw error;
    }
  }

  const session = await deps.createNewTab("New agent");
  const sessionId = session.id;
  const provisionalSessionId =
    findSessionByInitialId(sessionId)?.id ?? sessionId;
  useChatSessionStore.getState().patchSession(provisionalSessionId, {
    intent: "build-agent",
    agentBuilderOpen: true,
    targetAgentPath: null,
    targetAgentSlug: null,
    targetAgentDraftState: "preparing",
    targetAgentDraftSaved: false,
  });

  await deps.navigateChat(provisionalSessionId);
  void prepareProvisionalDraftTarget(sessionId).catch((error) => {
    console.error("Failed to prepare agent builder draft:", error);
    markAgentBuilderSessionPreparationFailed(sessionId);
  });
  return sessionId;
}

async function prepareProvisionalDraftTarget(
  initialSessionId: string,
): Promise<void> {
  const sessionId = await resolveFinalBuilderSessionId(initialSessionId);
  const target = await preSeedDraftAgent(sessionId);
  const chatStore = useChatSessionStore.getState();
  const session = chatStore.getSession(sessionId);

  if (!session || session.archivedAt || session.intent !== "build-agent") {
    await discardAgentBuilderSource(target.path).catch((error) => {
      console.error("Failed to discard canceled agent draft:", error);
    });
    return;
  }

  if (session.targetAgentPath) {
    await discardAgentBuilderSource(target.path).catch((error) => {
      console.error("Failed to discard duplicate agent draft:", error);
    });
    return;
  }

  chatStore.patchSession(sessionId, {
    intent: "build-agent",
    agentBuilderOpen: session.agentBuilderOpen,
    targetAgentPath: target.path,
    targetAgentSlug: target.slug,
    targetAgentDraftState: null,
    targetAgentDraftSaved: false,
  });
}

export function markAgentBuilderSessionPreparationFailed(
  initialSessionId: string,
): void {
  const session = findSessionByInitialId(initialSessionId);
  if (
    !session ||
    session.archivedAt ||
    session.intent !== "build-agent" ||
    session.targetAgentPath
  ) {
    return;
  }

  useChatSessionStore.getState().patchSession(session.id, {
    targetAgentDraftState: "failed",
  });
}

export function resolveAgentBuilderSessionId(initialSessionId: string): string {
  return findSessionByInitialId(initialSessionId)?.id ?? initialSessionId;
}

function resolveFinalBuilderSessionId(
  initialSessionId: string,
): Promise<string> {
  const immediate = readFinalBuilderSessionId(initialSessionId);
  if (immediate.status === "resolved") {
    return Promise.resolve(immediate.sessionId);
  }
  if (immediate.status === "failed") {
    return Promise.reject(new Error(immediate.message));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
    };
    const resolveWith = (sessionId: string) => {
      cleanup();
      resolve(sessionId);
    };
    const rejectWith = (error: Error) => {
      cleanup();
      reject(error);
    };

    const timeout = window.setTimeout(() => {
      rejectWith(
        new Error("Timed out waiting for agent builder session creation."),
      );
    }, 60_000);

    const unsubscribe = useChatSessionStore.subscribe(() => {
      const result = readFinalBuilderSessionId(initialSessionId);
      if (result.status === "resolved") {
        resolveWith(result.sessionId);
        return;
      }
      if (result.status === "failed") {
        rejectWith(new Error(result.message));
      }
    });
  });
}

function readFinalBuilderSessionId(
  initialSessionId: string,
):
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "resolved"; sessionId: string } {
  const session = findSessionByInitialId(initialSessionId);
  if (!session) {
    return {
      status: "failed",
      message: "Agent builder session closed before draft preparation.",
    };
  }

  if (session.archivedAt) {
    return {
      status: "failed",
      message: "Agent builder session was archived before draft preparation.",
    };
  }

  if (session.creationState === "failed") {
    return {
      status: "failed",
      message:
        session.creationError ?? "Agent builder session failed to start.",
    };
  }

  if (session.creationState === "pending") {
    return { status: "pending" };
  }

  return { status: "resolved", sessionId: session.id };
}

function findSessionByInitialId(initialSessionId: string) {
  const sessions = useChatSessionStore.getState().sessions;
  return sessions.find(
    (session) =>
      session.id === initialSessionId ||
      session.clientSessionId === initialSessionId,
  );
}

export async function recoverPendingDraftAgent(
  sessionId: string,
  stalePath?: string | null,
): Promise<{ path: string; slug: string }> {
  const finalSessionId = await resolveFinalBuilderSessionId(sessionId);
  return recoverDraftAgent(finalSessionId, stalePath);
}

export async function preSeedDraftAgent(
  sessionId: string,
): Promise<{ path: string; slug: string }> {
  const provider = getStoredProvider(useAgentStore.getState().providers);
  const preference =
    getStoredModelPreferenceForProvider(provider) ??
    (provider === "goose" ? getStoredModelPreference("goose") : null);
  const defaultModelProviderId = getDefaultGooseModelProviderId();
  const defaultModelId = getDefaultGooseModelId();
  let modelSelection: DraftAgentDefaults["modelSelection"];
  if (preference?.providerId) {
    modelSelection = {
      modelProviderId: preference.providerId,
      modelId: preference.modelId,
    };
  } else if (provider === "goose" && defaultModelProviderId && defaultModelId) {
    modelSelection = {
      modelProviderId: defaultModelProviderId,
      modelId: defaultModelId,
    };
  }
  return createDraftAgentSource(sessionId, {
    provider,
    modelSelection,
  });
}

export async function recoverDraftAgent(
  sessionId: string,
  stalePath?: string | null,
): Promise<{ path: string; slug: string }> {
  if (stalePath) {
    const existing = await findAgentBuilderSource(sessionId, stalePath);
    if (existing?.properties?.draft === true) {
      return sourceTarget(existing);
    }
  }

  const sources = await listAgentBuilderSources();
  const existing = sources.find(
    (source) =>
      source.properties?.draft === true &&
      source.properties.builderSessionId === sessionId,
  );
  if (existing) {
    return sourceTarget(existing);
  }

  return preSeedDraftAgent(sessionId);
}

export async function discardDraftAgentSession(
  sessionId: string,
  deps: CloseSessionDeps = {},
): Promise<void> {
  try {
    const source = await findCurrentBuilderSource(sessionId);
    if (source?.properties?.draft === true) {
      await discardAgentBuilderSource(source.path);
    }
  } catch (error) {
    console.warn("Failed to delete agent builder draft during discard:", error);
  } finally {
    clearBuilderSessionState(sessionId);
    await deps.closeSession?.(sessionId);
  }
}

export async function deleteDraftAgentSession(
  sessionId: string,
  deps: CloseSessionDeps = {},
): Promise<void> {
  const source = await findCurrentBuilderSource(sessionId);
  if (source?.properties?.draft === true) {
    await discardAgentBuilderSource(source.path);
  }

  clearBuilderSessionState(sessionId);
  await deps.closeSession?.(sessionId);
}

export async function promoteDraft(
  sessionId: string,
): Promise<AgentSourceEntry | null> {
  const source = await findCurrentBuilderSource(sessionId);
  if (!source) {
    clearBuilderSessionState(sessionId);
    return null;
  }

  const promoted = await promoteAgentBuilderDraftSource(source);

  clearBuilderSessionState(sessionId);
  return promoted;
}

export async function isEmptyDraftAgentSession(
  sessionId: string,
): Promise<boolean> {
  const source = await findCurrentBuilderSource(sessionId);
  if (source?.properties?.draft !== true) {
    return false;
  }

  let freshSource: AgentSourceEntry;
  try {
    freshSource = await readFreshAgentSource(source.path, source);
  } catch {
    return false;
  }

  return isEmptyPlaceholderDraft(freshSource);
}

export async function hasAgentBuilderSessionUserContent(
  sessionId: string,
): Promise<boolean> {
  if (localEditSessionIds.has(sessionId)) {
    return true;
  }

  const chatState = useChatStore.getState();
  const composerDraft = (chatState.draftsBySession[sessionId] ?? "").trim();
  if (
    composerDraft.length > 0 &&
    !AGENT_BUILDER_MENTION_INVOCATION.test(composerDraft)
  ) {
    return true;
  }

  const queuedMessages = chatState.queuedMessageBySession[sessionId] ?? [];
  if (queuedMessages.some((record) => record.payload.text.trim())) {
    return true;
  }

  const hasUserMessage = (chatState.messagesBySession[sessionId] ?? []).some(
    (message) => {
      if (message.role !== "user" || message.metadata?.userVisible === false) {
        return false;
      }

      return (
        getTextContent(message).trim().length > 0 ||
        (message.metadata?.attachments?.length ?? 0) > 0
      );
    },
  );
  if (hasUserMessage) {
    return true;
  }

  const source = await findCurrentBuilderSource(sessionId);
  if (source?.properties?.draft !== true) {
    return false;
  }

  let freshSource: AgentSourceEntry;
  try {
    freshSource = await readFreshAgentSource(source.path, source);
  } catch {
    return !isEmptyPlaceholderDraft(source);
  }

  return !isEmptyPlaceholderDraft(freshSource);
}

export async function isDraftAgentBuilderSession(
  sessionId: string,
): Promise<boolean> {
  const source = await findCurrentBuilderSource(sessionId);
  return source?.properties?.draft === true;
}

export async function reconcileAgentBuilderSessions(): Promise<void> {
  const allSources = await listAgentBuilderSources();
  const draftSources = allSources.filter(
    (source) => source.properties?.draft === true,
  );
  const chatStore = useChatSessionStore.getState();

  for (const source of draftSources) {
    const builderSessionId =
      typeof source.properties?.builderSessionId === "string"
        ? source.properties.builderSessionId
        : null;
    if (!builderSessionId) {
      continue;
    }

    const session = chatStore.getSession(builderSessionId);
    if (session && !session.archivedAt) {
      chatStore.patchSession(builderSessionId, {
        intent: "build-agent",
        agentBuilderOpen: session.agentBuilderOpen ?? true,
        targetAgentPath: source.path,
        targetAgentSlug: fileStem(source.path) || deriveSlug(source.name),
        targetAgentDraftState: null,
        targetAgentDraftSaved: true,
      });
      continue;
    }

    if (isSessionKnownDead(chatStore, builderSessionId)) {
      await deleteIfFreshPlaceholderDraft(source);
    }
  }
}

export function clearBuilderSessionState(sessionId: string): void {
  localEditSessionIds.delete(sessionId);
  localSaveHandlersBySessionId.delete(sessionId);

  useChatSessionStore.getState().patchSession(sessionId, {
    intent: null,
    agentBuilderOpen: false,
    agentBuilderContextState: undefined,
    targetAgentPath: null,
    targetAgentSlug: null,
    targetAgentDraftState: null,
    targetAgentDraftSaved: false,
  });

  const chatStore = useChatStore.getState();
  const nextSkills = removeAgentBuilderSkillDraft(
    chatStore.skillDraftsBySession[sessionId] ?? [],
  );
  chatStore.setSkillDrafts(sessionId, nextSkills);
}

async function findCurrentBuilderSource(
  sessionId: string,
): Promise<AgentSourceEntry | undefined> {
  const session = useChatSessionStore.getState().getSession(sessionId);
  const targetPath = session?.targetAgentPath;
  if (targetPath) {
    return findAgentBuilderSource(sessionId, targetPath);
  }

  const sources = await listAgentBuilderSources();
  const source = sources.find(
    (candidate) => candidate.properties?.builderSessionId === sessionId,
  );
  if (!source) {
    return undefined;
  }

  try {
    return await readFreshAgentSource(source.path, source);
  } catch {
    return source;
  }
}

function findLiveBuilderSession({
  path,
  slug,
}: {
  path?: string;
  slug?: string;
}) {
  return useChatSessionStore
    .getState()
    .sessions.find(
      (session) =>
        !session.archivedAt &&
        session.intent === "build-agent" &&
        ((path && session.targetAgentPath === path) ||
          (slug && session.targetAgentSlug === slug)),
    );
}

async function resolveExistingAgentTarget(
  target: Pick<StartAgentBuilderSessionArgs, "path" | "slug">,
): Promise<{ path: string; slug: string }> {
  const { path, slug } = target;
  const source = (await listAgentBuilderSources()).find(
    (source) =>
      (path && source.path === path) ||
      (slug && fileStem(source.path) === slug),
  );
  if (!source) {
    throw new Error(
      `No persona source matches ${path ? `path: ${path}` : `slug: ${slug}`}`,
    );
  }

  return {
    path: source.path,
    slug: fileStem(source.path) || slug || source.name,
  };
}

function sourceTarget(source: AgentSourceEntry): {
  path: string;
  slug: string;
} {
  return {
    path: source.path,
    slug: fileStem(source.path) || deriveSlug(source.name),
  };
}

function isSessionKnownDead(
  chatStore: ReturnType<typeof useChatSessionStore.getState>,
  sessionId: string,
): boolean {
  if (chatStore.getSession(sessionId)) {
    return false;
  }

  return (
    chatStore.hasHydratedSessions === true &&
    chatStore.hasMoreSessions === false
  );
}
