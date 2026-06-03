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
import { DEFAULT_MODEL_ID } from "@/features/migration/lib/constants";
import {
  createDraftAgentSource,
  deleteIfFreshPlaceholderDraft,
  discardAgentBuilderSource,
  findAgentBuilderSource,
  listAgentBuilderSources,
  promoteAgentBuilderDraftSource,
  readFreshAgentSource,
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

export async function startAgentBuilderSession(
  { path, slug }: StartAgentBuilderSessionArgs = {},
  deps: StartAgentBuilderSessionDeps,
): Promise<string> {
  if (path || slug) {
    const existing = findLiveBuilderSession({ path, slug });
    if (existing) {
      await deps.navigateChat(existing.id);
      return existing.id;
    }
  }

  const session = await deps.createNewTab("New agent", { activate: false });
  const sessionId = session.id;

  try {
    const target =
      path || slug
        ? await resolveExistingAgentTarget({ path, slug })
        : await preSeedDraftAgent(sessionId);

    useChatSessionStore.getState().patchSession(sessionId, {
      intent: "build-agent",
      targetAgentPath: target.path,
      targetAgentSlug: target.slug,
    });

    await deps.navigateChat(sessionId);
    return sessionId;
  } catch (error) {
    await deps.closeSession(sessionId);
    throw error;
  }
}

export async function preSeedDraftAgent(
  sessionId: string,
): Promise<{ path: string; slug: string }> {
  const provider = getStoredProvider(useAgentStore.getState().providers);
  const model =
    getStoredModelPreferenceForProvider(provider)?.modelId ??
    getStoredModelPreference("goose")?.modelId ??
    DEFAULT_MODEL_ID;
  return createDraftAgentSource(sessionId, { provider, model });
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

  const queuedMessage = chatState.queuedMessageBySession[sessionId];
  if (queuedMessage?.text.trim()) {
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
        targetAgentPath: source.path,
        targetAgentSlug: fileStem(source.path) || deriveSlug(source.name),
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

  useChatSessionStore.getState().patchSession(sessionId, {
    intent: null,
    targetAgentPath: null,
    targetAgentSlug: null,
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
