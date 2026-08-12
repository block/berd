import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getSkillProviderCapabilities } from "@/features/chat/lib/skillProviderCapabilities";
import {
  listAgentFileSkills,
  listBerdAppSkills,
  listGooseSourceSkills,
  listSkills,
  type ListSkillsOptions,
  type SkillInfo,
} from "./skills";

/**
 * Shared react-query routing for skill lists, mirroring
 * `home/widgets/skillQueryKey.ts` and `useDoctorReport.ts`: the chat session
 * controller, mention handlers, and skill search all read through the same
 * per-argument keys so simultaneous mounts share one in-flight request and a
 * short cache instead of each issuing their own `list_agent_skills` /
 * `list_berd_app_skills` call. Each discovery leg is cached under its own key
 * so consumers that want different slices (with or without app skills) still
 * share the underlying fetches.
 */
export const SKILLS_QUERY_KEY_PREFIX = ["skills"] as const;

export const BERD_APP_SKILLS_QUERY_KEY = [
  ...SKILLS_QUERY_KEY_PREFIX,
  "berd-app",
] as const;

// Long enough to absorb the mount/navigation bursts that previously fanned
// out duplicate IPC calls, short enough that external skill-file edits show
// up on the next navigation. In-app mutations bypass it via `fresh`.
const SKILLS_LIST_STALE_TIME = 15_000;

function gooseSourceSkillsQueryKey(projectDirs: string[]) {
  return [...SKILLS_QUERY_KEY_PREFIX, "goose-source", projectDirs] as const;
}

function agentFileSkillsQueryKey(
  providerId: string | null | undefined,
  projectDirs: string[],
) {
  return [
    ...SKILLS_QUERY_KEY_PREFIX,
    "agent-files",
    providerId ?? null,
    projectDirs,
  ] as const;
}

function normalizeProjectDirs(projectDirs: string[]): string[] {
  return [...new Set(projectDirs.map((dir) => dir.trim()).filter(Boolean))];
}

function withoutAppSkills(skills: SkillInfo[]): SkillInfo[] {
  return skills.filter((skill) => skill.sourceKind !== "app");
}

export interface FetchSkillsListOptions extends ListSkillsOptions {
  /** Bypass the staleTime window (and, threaded down, the shared app-skills
   *  invoke), e.g. right after a skills-changed event. */
  fresh?: boolean;
}

/**
 * Fetch one skill-list leg through react-query, cancelling any in-flight
 * request for the key first when `fresh`. A plain `fetchQuery` dedupes onto a
 * fetch that is already running for the same key, so a "fresh" read triggered by
 * a skills-changed event that lands mid-burst would otherwise resolve with the
 * pre-change list and cache it for the full stale window — the old
 * `useSkillSearch` cache dropped its in-flight request on force-refresh for
 * exactly this reason. Cancelling first guarantees the fresh read observes
 * post-event data.
 *
 * The cancel is awaited (not fire-and-forget) so it lands during the
 * synchronous skills-changed listener sweep while the `fetchQuery` is deferred a
 * microtask: sibling fresh reloads on a shared key — e.g. the app-skills leg
 * read by both the search and mention consumers — then coalesce onto the one
 * refetch instead of cancelling each other's fresh request.
 */
function fetchSkillLeg(
  queryClient: QueryClient,
  queryKey: QueryKey,
  queryFn: () => Promise<SkillInfo[]>,
  fresh: boolean | undefined,
): Promise<SkillInfo[]> {
  if (!fresh) {
    return queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: SKILLS_LIST_STALE_TIME,
      retry: false,
    });
  }
  return (async () => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    return queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: 0,
      retry: false,
    });
  })();
}

export function fetchBerdAppSkills(
  queryClient: QueryClient | undefined,
  options: { fresh?: boolean } = {},
): Promise<SkillInfo[]> {
  if (!queryClient) {
    return listBerdAppSkills({ coalesce: !options.fresh });
  }
  // `fresh` must reach the shareInFlight wrapper too: `cancelQueries` discards
  // the query-layer promise but does not abort the underlying invoke, so a
  // fresh queryFn run that coalesced would be handed the previous unsettled
  // invoke and resolve with the pre-cancel snapshot. Only the mount-burst
  // (non-fresh) path opts into sharing.
  return fetchSkillLeg(
    queryClient,
    BERD_APP_SKILLS_QUERY_KEY,
    () => listBerdAppSkills({ coalesce: !options.fresh }),
    options.fresh,
  );
}

export async function fetchSkillsList(
  queryClient: QueryClient | undefined,
  projectDirs: string[],
  options: FetchSkillsListOptions = {},
): Promise<SkillInfo[]> {
  const { fresh, ...listOptions } = options;
  if (!queryClient) {
    // The provider-less fallback has no query layer to cancel, but `fresh`
    // must still reach the shared app-skills invoke: `listSkills` threads it
    // to `listBerdAppSkills` so a skills-changed reload doesn't join an
    // app-skill request that started before the change.
    return listSkills(projectDirs, options);
  }

  const normalizedDirs = normalizeProjectDirs(projectDirs);
  const capabilities = getSkillProviderCapabilities(listOptions.providerId);
  if (capabilities.discoveryMode === "agent-skill-files") {
    const skills = await fetchSkillLeg(
      queryClient,
      agentFileSkillsQueryKey(listOptions.providerId, normalizedDirs),
      () => listAgentFileSkills(normalizedDirs, listOptions.providerId),
      fresh,
    );
    return listOptions.includeAppSkills === false
      ? withoutAppSkills(skills)
      : skills;
  }

  const [gooseSkills, appSkills] = await Promise.all([
    fetchSkillLeg(
      queryClient,
      gooseSourceSkillsQueryKey(normalizedDirs),
      () => listGooseSourceSkills(normalizedDirs),
      fresh,
    ),
    listOptions.includeAppSkills === false
      ? []
      : fetchBerdAppSkills(queryClient, { fresh }),
  ]);
  // Same ordering contract as `listSkills`: Goose sources first, app skills
  // appended so a same-named Personal skill wins bare-name activation.
  return [...gooseSkills, ...appSkills];
}

/** Synchronous snapshot of an already-cached skill list so consumers (e.g.
 *  the search dropdown) can paint instantly while `fetchSkillsList` runs. */
export function getCachedSkillsList(
  queryClient: QueryClient | undefined,
  projectDirs: string[],
  options: ListSkillsOptions = {},
): SkillInfo[] | undefined {
  if (!queryClient) {
    return undefined;
  }

  const normalizedDirs = normalizeProjectDirs(projectDirs);
  const capabilities = getSkillProviderCapabilities(options.providerId);
  if (capabilities.discoveryMode === "agent-skill-files") {
    const skills = queryClient.getQueryData<SkillInfo[]>(
      agentFileSkillsQueryKey(options.providerId, normalizedDirs),
    );
    if (!skills) {
      return undefined;
    }
    return options.includeAppSkills === false
      ? withoutAppSkills(skills)
      : skills;
  }

  const gooseSkills = queryClient.getQueryData<SkillInfo[]>(
    gooseSourceSkillsQueryKey(normalizedDirs),
  );
  if (!gooseSkills) {
    return undefined;
  }
  if (options.includeAppSkills === false) {
    return gooseSkills;
  }
  const appSkills = queryClient.getQueryData<SkillInfo[]>(
    BERD_APP_SKILLS_QUERY_KEY,
  );
  return appSkills ? [...gooseSkills, ...appSkills] : gooseSkills;
}
