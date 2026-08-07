import {
  createPersonaSource,
  deletePersonaSource,
  listPersonaSources,
  promotePersonaSource,
  readAgentSourceFile,
  updatePersonaSource,
  type AgentSourceEntry,
  type AgentSourceProperties,
  type CreatePersonaSourceRequest,
  type PersonaSourcePatch,
} from "@/shared/api/agents";
import {
  deriveSlug,
  fileStem,
  isEmptyPlaceholderDraft,
  isPlaceholderDraftForSession,
  PLACEHOLDER_AGENT_BODY,
  PLACEHOLDER_AGENT_DESCRIPTION,
  placeholderAgentName,
} from "./agentBuilderIdentity";

export type { AgentSourceEntry, PersonaSourcePatch };

const localDraftSourcesByPath = new Map<string, AgentSourceEntry>();

export async function listAgentBuilderSources(): Promise<AgentSourceEntry[]> {
  const sources = await listPersonaSources();
  return mergeLocalDraftSources(sources);
}

export interface DraftAgentDefaults {
  provider?: string;
  modelSelection?: {
    modelProviderId: string;
    modelId: string;
  };
}

export async function createDraftAgentSource(
  sessionId: string,
  defaults?: DraftAgentDefaults,
): Promise<{ path: string; slug: string }> {
  const properties: AgentSourceProperties = {
    draft: true,
    builderSessionId: sessionId,
  };
  if (defaults?.provider) {
    properties.provider = defaults.provider;
  }
  if (defaults?.modelSelection) {
    properties.modelProviderId = defaults.modelSelection.modelProviderId;
    properties.model = defaults.modelSelection.modelId;
  }

  const request: CreatePersonaSourceRequest = {
    type: "agent",
    name: placeholderAgentName(sessionId),
    description: PLACEHOLDER_AGENT_DESCRIPTION,
    content: PLACEHOLDER_AGENT_BODY,
    target: { scope: "global" },
    properties,
  };
  const created = await createPersonaSource(request);
  localDraftSourcesByPath.set(created.path, created);

  return {
    path: created.path,
    slug: fileStem(created.path) || deriveSlug(created.name),
  };
}

export async function readFreshAgentSource(
  path: string,
  fallback?: AgentSourceEntry,
): Promise<AgentSourceEntry> {
  return readAgentSourceFile(path, fallback);
}

export async function updateAgentBuilderSource(
  path: string,
  patch: PersonaSourcePatch,
): Promise<AgentSourceEntry> {
  const cachedDraft = localDraftSourcesByPath.get(path);
  const cachedProperties = cachedDraft?.properties;
  const effectivePatch = isBuilderDraftProperties(cachedProperties)
    ? {
        ...patch,
        properties: {
          ...cachedProperties,
          ...(patch.properties ?? {}),
        },
      }
    : patch;
  const updated = preserveCachedDraftMetadata(
    await updatePersonaSource(path, effectivePatch),
    cachedDraft,
  );
  if (updated.path !== path) {
    localDraftSourcesByPath.delete(path);
  }
  rememberDraftSource(updated);
  return updated;
}

export async function discardAgentBuilderSource(path: string): Promise<void> {
  await deletePersonaSource(path);
  localDraftSourcesByPath.delete(path);
}

export function forgetLocalAgentBuilderSource(path: string): void {
  localDraftSourcesByPath.delete(path);
}

export async function promoteAgentBuilderDraftSource(
  source: AgentSourceEntry,
): Promise<AgentSourceEntry> {
  if (source.properties?.draft !== true) {
    return source;
  }

  return promotePersonaSource(source.path, {
    name: source.name,
    description: source.description,
    content: source.content,
    properties: source.properties,
  }).finally(() => {
    localDraftSourcesByPath.delete(source.path);
  });
}

export async function findAgentBuilderSource(
  sessionId: string,
  path: string,
): Promise<AgentSourceEntry | undefined> {
  const sources = await listAgentBuilderSources();
  const foundByPath = sources.find((source) => source.path === path);
  const sessionMatches = sources.filter(
    (source) => source.properties?.builderSessionId === sessionId,
  );
  const movedNonPlaceholder = sessionMatches.find(
    (source) => source.path !== path && !isEmptyPlaceholderDraft(source),
  );

  if (foundByPath && !isEmptyPlaceholderDraft(foundByPath)) {
    return readListedDraftFresh(foundByPath);
  }

  const listedSource = movedNonPlaceholder ?? foundByPath ?? sessionMatches[0];
  if (listedSource) {
    return readListedDraftFresh(listedSource);
  }

  try {
    return await readAgentSourceFile(path);
  } catch {
    return undefined;
  }
}

export async function deleteIfFreshPlaceholderDraft(
  source: AgentSourceEntry,
): Promise<boolean> {
  const builderSessionId =
    typeof source.properties?.builderSessionId === "string"
      ? source.properties.builderSessionId
      : null;
  if (!builderSessionId) {
    return false;
  }
  if (!isPlaceholderDraftForSession(source, builderSessionId)) {
    return false;
  }

  let freshSource: AgentSourceEntry;
  try {
    freshSource = await readFreshAgentSource(source.path, source);
  } catch {
    return false;
  }

  if (!isPlaceholderDraftForSession(freshSource, builderSessionId)) {
    return false;
  }

  await deletePersonaSource(freshSource.path);
  localDraftSourcesByPath.delete(freshSource.path);
  return true;
}

export function resetAgentBuilderSourceLifecycleForTests(): void {
  localDraftSourcesByPath.clear();
}

function mergeLocalDraftSources(
  sources: AgentSourceEntry[],
): AgentSourceEntry[] {
  const byPath = new Map<string, AgentSourceEntry>();

  for (const source of sources) {
    const cachedDraft = localDraftSourcesByPath.get(source.path);
    const merged = preserveCachedDraftMetadata(source, cachedDraft);
    byPath.set(merged.path, merged);
    rememberDraftSource(merged);
  }

  for (const [path, source] of localDraftSourcesByPath) {
    if (!byPath.has(path)) {
      byPath.set(path, source);
    }
  }

  return [...byPath.values()];
}

function preserveCachedDraftMetadata(
  source: AgentSourceEntry,
  cachedDraft: AgentSourceEntry | undefined,
): AgentSourceEntry {
  const cachedProperties = cachedDraft?.properties;
  if (!isBuilderDraftProperties(cachedProperties)) {
    return source;
  }

  if (source.properties?.draft === false) {
    return source;
  }

  return {
    ...source,
    properties: {
      ...cachedProperties,
      ...(source.properties ?? {}),
    },
  };
}

function rememberDraftSource(source: AgentSourceEntry): void {
  if (isBuilderDraftSource(source)) {
    localDraftSourcesByPath.set(source.path, source);
    return;
  }

  localDraftSourcesByPath.delete(source.path);
}

function isBuilderDraftSource(source: AgentSourceEntry | undefined): boolean {
  return isBuilderDraftProperties(source?.properties);
}

function isBuilderDraftProperties(
  properties: AgentSourceEntry["properties"] | undefined,
): properties is NonNullable<AgentSourceEntry["properties"]> & {
  draft: true;
  builderSessionId: string;
} {
  return (
    properties?.draft === true &&
    typeof properties.builderSessionId === "string"
  );
}

async function readListedDraftFresh(
  source: AgentSourceEntry,
): Promise<AgentSourceEntry> {
  if (source.properties?.draft !== true) {
    return source;
  }

  try {
    return await readAgentSourceFile(source.path, source);
  } catch {
    return source;
  }
}
