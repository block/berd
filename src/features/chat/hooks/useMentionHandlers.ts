import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { fetchSkillsList } from "@/features/skills/api/skillsQuery";
import { listenSkillsChanged } from "@/features/skills/lib/skillsEvents";
import { useAtMentionDefaultCategoryPreference } from "@/features/chat/lib/mentionPreference";
import {
  expandSkillSlashCommand,
  resolveSkillSlashCommand,
} from "@/features/skills/lib/skillChatPrompt";
import {
  getHomeDir,
  searchFilesForMentions,
  type FileMentionPathEntry,
} from "@/shared/api/system";
import type { Persona } from "@/shared/types/agents";
import {
  useMentionDetection,
  type FileMentionItem,
  type MentionItem,
  type SkillMentionItem,
} from "../ui/MentionAutocomplete";
import { useSessionArtifacts } from "./ArtifactPolicyContext";

interface MentionHandlersOptions {
  personas: Persona[];
  skillProjectDirs?: string[] | undefined;
  fileMentionProjectDirs?: string[] | undefined;
  skillProviderId?: string | null | undefined;
  skillsEnabled?: boolean;
  fileMentionsEnabled?: boolean;
  text: string;
  setText: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  activePersonaId?: string | null;
  onPersonaChange?: ((id: string | null) => void) | undefined;
  onSkillMentionSelect?: (skill: SkillMentionItem) => void;
  onFileMentionSelect?: (file: FileMentionItem) => void;
}

const FILE_MENTION_SEARCH_DEBOUNCE_MS = 90;
const FILE_MENTION_SEARCH_LIMIT = 12;
const PATH_SEARCH_CACHE_TTL_MS = 60_000;
const MAX_PATH_SEARCH_CACHE_ENTRIES = 200;

type PathSearchCacheEntry = {
  entries: FileMentionPathEntry[];
  cachedAt: number;
};

function dedupeSkillMentionItems(
  skills: SkillMentionItem[],
): SkillMentionItem[] {
  const seenNames = new Set<string>();
  const deduped: SkillMentionItem[] = [];

  for (const skill of skills) {
    const normalizedName = skill.name.trim().toLowerCase();
    if (!normalizedName || seenNames.has(normalizedName)) {
      continue;
    }
    seenNames.add(normalizedName);
    deduped.push(skill);
  }

  return deduped;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizeProjectRootPrefixedQuery(
  query: string,
  roots: string[],
): {
  query: string;
  hadProjectRootPrefix: boolean;
  projectRoot: string | null;
} {
  const normalizedQuery = query.replace(/\\/g, "/");
  const lowerQuery = normalizedQuery.toLowerCase();
  for (const root of roots) {
    const rootName = basename(root).toLowerCase();
    if (!rootName) continue;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (lowerQuery === rootName) {
      return {
        query: normalizedRoot,
        hadProjectRootPrefix: true,
        projectRoot: root,
      };
    }
    if (lowerQuery === `${rootName}/`) {
      return {
        query: `${normalizedRoot}/`,
        hadProjectRootPrefix: true,
        projectRoot: root,
      };
    }
    if (lowerQuery.startsWith(`${rootName}/`)) {
      return {
        query: normalizedQuery.slice(rootName.length + 1),
        hadProjectRootPrefix: true,
        projectRoot: root,
      };
    }
  }
  return { query, hadProjectRootPrefix: false, projectRoot: null };
}

function normalizeRoots(roots: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (roots ?? [])
        .map((root) => root.trim())
        .filter((root) => root.length > 0),
    ),
  );
}

function filesystemRootFromPath(path: string | null): string {
  if (!path) return "/";
  const windowsRoot = path.match(/^[A-Za-z]:[\\/]/);
  if (windowsRoot) return windowsRoot[0].replace(/\//g, "\\");
  return "/";
}

function isFilesystemRootQuery(query: string): boolean {
  return query === "/" || /^[A-Za-z]:[\\/]?$/.test(query);
}

function isFilesystemPathSearchQuery(query: string): boolean {
  return (
    (query.startsWith("/") && query !== "/") ||
    query.startsWith("~/") ||
    query.startsWith("~\\") ||
    /^[A-Za-z]:[\\/].+/.test(query)
  );
}

function shouldSearchPathMentions(
  query: string,
  hasProjectRoots: boolean,
): boolean {
  const trimmed = query.trim();
  if (!trimmed || isFilesystemRootQuery(trimmed)) {
    return false;
  }
  if (isFilesystemPathSearchQuery(trimmed)) return true;
  if (trimmed.startsWith("~") || !hasProjectRoots) return false;
  if (trimmed.length === 1 && /^[A-Za-z0-9]$/.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Drop per-query match metadata from entries that are about to be re-scored
 * against a different query. Backend ranks are only trusted for the query
 * they were computed for; while a new search is debounced or in flight (or
 * after it fails), stale entries must fall back to local re-scoring so
 * entries that no longer match the live query get filtered out.
 */
function stripStaleMatchMetadata(
  entries: FileMentionPathEntry[],
): FileMentionPathEntry[] {
  if (
    !entries.some(
      (entry) => entry.matchRank != null || entry.matchHighlight != null,
    )
  ) {
    return entries;
  }
  return entries.map(
    ({ matchRank: _rank, matchHighlight: _highlight, ...rest }) => rest,
  );
}

function sameFileMentionHighlight(
  a: FileMentionPathEntry["matchHighlight"],
  b: FileMentionPathEntry["matchHighlight"],
): boolean {
  if (!a || !b) return a === b;
  return (
    a.target === b.target &&
    a.indices.length === b.indices.length &&
    a.indices.every((index, i) => index === b.indices[i])
  );
}

function sameFileMentionArray(
  a: FileMentionPathEntry[],
  b: FileMentionPathEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.resolvedPath !== right.resolvedPath ||
      left.displayPath !== right.displayPath ||
      left.filename !== right.filename ||
      left.kind !== right.kind ||
      left.source !== right.source ||
      left.matchRank !== right.matchRank ||
      !sameFileMentionHighlight(left.matchHighlight, right.matchHighlight)
    ) {
      return false;
    }
  }
  return true;
}

function rememberPathSearchEntries(
  cache: Map<string, PathSearchCacheEntry>,
  key: string,
  entries: FileMentionPathEntry[],
) {
  cache.delete(key);
  cache.set(key, { entries, cachedAt: Date.now() });
  while (cache.size > MAX_PATH_SEARCH_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

function addFileMentionItem(
  dedup: Map<string, FileMentionItem>,
  item: FileMentionItem,
) {
  const key = item.resolvedPath.trim().toLowerCase();
  if (!key) return;
  const existing = dedup.get(key);
  if (!existing) {
    dedup.set(key, item);
    return;
  }
  // Keep the first copy (session/static items carry shortcut and source
  // semantics) but adopt the backend's match metadata, so files already in
  // the chat rank and highlight like any other backend match. Highlight
  // indices only transfer when they index the string this copy renders
  // (a session artifact's displayPath can differ from the backend's).
  if (existing.matchRank == null && item.matchRank != null) {
    const highlight = item.matchHighlight;
    const highlightApplies =
      highlight?.target === "filename"
        ? existing.filename === item.filename
        : existing.displayPath === item.displayPath;
    dedup.set(key, {
      ...existing,
      matchRank: item.matchRank,
      matchHighlight: highlight && highlightApplies ? highlight : undefined,
    });
  }
}

function toFileMentionItem(entry: FileMentionPathEntry): FileMentionItem {
  return {
    resolvedPath: entry.resolvedPath,
    displayPath: entry.displayPath,
    filename: entry.filename,
    kind: entry.kind,
    source: entry.source,
    matchRank: entry.matchRank,
    matchHighlight: entry.matchHighlight,
  };
}

function buildStaticPathItems(
  roots: string[],
  homeDir: string | null,
): FileMentionItem[] {
  const entries: FileMentionItem[] = roots.map((root) => {
    const name = basename(root);
    return {
      resolvedPath: root,
      displayPath: "Project root",
      filename: name,
      kind: "folder",
      source: "project",
      shortcut: "projectRoot",
    };
  });

  if (homeDir) {
    entries.push({
      resolvedPath: homeDir,
      displayPath: homeDir,
      filename: "Home folder",
      kind: "path",
      source: "home",
      shortcut: "home",
    });
  }

  const filesystemRoot = filesystemRootFromPath(homeDir);
  entries.push({
    resolvedPath: filesystemRoot,
    displayPath: filesystemRoot,
    filename: "Filesystem root",
    kind: "path",
    source: "filesystem",
    shortcut: "filesystemRoot",
  });

  return entries;
}

function removeMentionQuery(
  text: string,
  mentionStartIndex: number,
  mentionQuery: string,
) {
  const before = text.slice(0, mentionStartIndex);
  const after = text.slice(mentionStartIndex + 1 + mentionQuery.length);
  const needsSpace =
    before.length > 0 &&
    after.length > 0 &&
    !/\s$/.test(before) &&
    !/^\s/.test(after) &&
    !/^[.,!?;:)]/.test(after);
  const separator = needsSpace ? " " : "";
  const newText = `${before}${separator}${after}`;

  return {
    newText,
    cursorPosition: before.length + separator.length,
  };
}

export function replaceMentionQuery(
  text: string,
  mentionStartIndex: number,
  mentionQuery: string,
  replacement: string,
) {
  const before = text.slice(0, mentionStartIndex);
  const after = text.slice(mentionStartIndex + 1 + mentionQuery.length);
  const separator =
    after.length === 0 || (!/^\s/.test(after) && !/^[.,!?;:)]/.test(after))
      ? " "
      : "";
  const newText = `${before}${replacement}${separator}${after}`;

  return {
    newText,
    cursorPosition: before.length + replacement.length + separator.length,
  };
}

function isCompletablePathMention(file: FileMentionItem): boolean {
  return file.kind !== "file";
}

function withTrailingPathSeparator(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || /[\\/]$/.test(trimmed)) {
    return trimmed;
  }
  const separator =
    trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${separator}`;
}

/**
 * Combines persona + skill + file mention detection, filtering, and selection handlers.
 * Keeps ChatInput under the file-size limit by centralising mention logic.
 */
export function useMentionHandlers({
  personas,
  skillProjectDirs,
  fileMentionProjectDirs,
  skillProviderId,
  skillsEnabled = true,
  fileMentionsEnabled = true,
  text,
  setText,
  textareaRef,
  activePersonaId,
  onPersonaChange,
  onSkillMentionSelect,
  onFileMentionSelect,
}: MentionHandlersOptions) {
  const sessionArtifacts = useSessionArtifacts();
  // Optional so provider-less mounts (tests) fall back to a direct fetch;
  // with a client, the skill list shares one react-query entry with the
  // session controller and skill search instead of refetching per mount.
  const queryClient = useContext(QueryClientContext);
  const normalizedSkillRoots = useMemo(
    () => normalizeRoots(skillProjectDirs),
    [skillProjectDirs],
  );
  const normalizedFileMentionRoots = useMemo(
    () => normalizeRoots(fileMentionProjectDirs),
    [fileMentionProjectDirs],
  );
  const rootsKey = useMemo(
    () => normalizedFileMentionRoots.join("\n"),
    [normalizedFileMentionRoots],
  );
  const [projectFileEntries, setProjectFileEntries] = useState<
    FileMentionPathEntry[]
  >([]);
  const [fileMentionsLoading, setFileMentionsLoading] = useState(false);
  const [fileMentionsError, setFileMentionsError] = useState<string | null>(
    null,
  );
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [skillMentionItems, setSkillMentionItems] = useState<
    SkillMentionItem[]
  >([]);
  const pathSearchCacheRef = useRef<Map<string, PathSearchCacheEntry>>(
    new Map(),
  );
  const pathSearchInFlightRef = useRef<
    Map<string, Promise<FileMentionPathEntry[]>>
  >(new Map());
  const { category: preferredAtMentionCategory } =
    useAtMentionDefaultCategoryPreference();
  const defaultAtMentionCategory = fileMentionsEnabled
    ? preferredAtMentionCategory
    : "agents";
  const pathSearchRequestIdRef = useRef(0);
  if (!skillsEnabled && skillMentionItems.length > 0) {
    setSkillMentionItems([]);
  }

  useEffect(() => {
    let cancelled = false;

    void getHomeDir()
      .then((dir) => {
        if (!cancelled) setHomeDir(dir);
      })
      .catch(() => {
        if (!cancelled) setHomeDir(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    if (!skillsEnabled) {
      return;
    }

    const loadSkillMentions = (options: { fresh?: boolean } = {}) => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;

      void fetchSkillsList(queryClient, normalizedSkillRoots, {
        providerId: skillProviderId,
        fresh: options.fresh,
      })
        .then((skills) => {
          if (cancelled || currentRequestId !== requestId) return;
          setSkillMentionItems(
            dedupeSkillMentionItems(
              skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                sourceLabel: skill.sourceLabel,
                instructions: skill.instructions,
                fileLocation: skill.fileLocation,
              })),
            ),
          );
        })
        .catch((error) => {
          if (cancelled || currentRequestId !== requestId) return;
          console.error("Failed to load skills for mentions:", error);
          setSkillMentionItems([]);
        });
    };

    loadSkillMentions();
    const cleanup = listenSkillsChanged(() =>
      loadSkillMentions({ fresh: true }),
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [normalizedSkillRoots, queryClient, skillProviderId, skillsEnabled]);

  const fileMentionItems: FileMentionItem[] = useMemo(() => {
    const dedup = new Map<string, FileMentionItem>();

    if (!fileMentionsEnabled) {
      return [];
    }

    for (const artifact of sessionArtifacts) {
      addFileMentionItem(dedup, {
        resolvedPath: artifact.resolvedPath,
        displayPath: artifact.displayPath,
        filename: artifact.filename,
        kind: artifact.kind,
        source: "session",
      });
    }

    for (const item of buildStaticPathItems(
      normalizedFileMentionRoots,
      homeDir,
    )) {
      addFileMentionItem(dedup, item);
    }
    for (const entry of projectFileEntries) {
      addFileMentionItem(dedup, toFileMentionItem(entry));
    }

    return Array.from(dedup.values());
  }, [
    fileMentionsEnabled,
    sessionArtifacts,
    homeDir,
    projectFileEntries,
    normalizedFileMentionRoots,
  ]);

  const {
    mentionOpen,
    mentionTrigger,
    atMentionCategory,
    mentionQuery,
    mentionStartIndex,
    mentionSelectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    detectMention,
    closeMention,
    dismissMention,
    navigateMention,
    navigateAtMentionCategory,
    setAtMentionCategory,
    handleMentionCategoryKey,
    confirmMention,
    registerCompletedMention,
  } = useMentionDetection(
    personas,
    skillMentionItems,
    fileMentionItems,
    defaultAtMentionCategory,
    text,
  );

  const pathMentionQuery = mentionQuery.trim();
  const normalizedPathMentionSearch = normalizeProjectRootPrefixedQuery(
    pathMentionQuery,
    normalizedFileMentionRoots,
  );
  const pathMentionSearchQuery = normalizedPathMentionSearch.query;
  const pathMentionSearchRoot = normalizedPathMentionSearch.projectRoot;
  const pathMentionSearchRoots = useMemo(
    () =>
      pathMentionSearchRoot
        ? [pathMentionSearchRoot]
        : normalizedFileMentionRoots,
    [normalizedFileMentionRoots, pathMentionSearchRoot],
  );
  const pathMentionSearchRootsKey = pathMentionSearchRoots.join("\0");
  const pathMentionSearchKey =
    fileMentionsEnabled &&
    mentionOpen &&
    atMentionCategory === "files" &&
    (normalizedPathMentionSearch.hadProjectRootPrefix ||
      shouldSearchPathMentions(pathMentionSearchQuery, rootsKey.length > 0))
      ? `${pathMentionSearchRootsKey}\0${pathMentionSearchQuery}\0${FILE_MENTION_SEARCH_LIMIT}`
      : "";
  const pathMentionCachedEntry = pathMentionSearchKey
    ? pathSearchCacheRef.current.get(pathMentionSearchKey)
    : null;
  const pathMentionCachedEntries =
    pathMentionCachedEntry &&
    Date.now() - pathMentionCachedEntry.cachedAt <= PATH_SEARCH_CACHE_TTL_MS
      ? pathMentionCachedEntry.entries
      : null;
  if (pathMentionCachedEntry && !pathMentionCachedEntries) {
    pathSearchCacheRef.current.delete(pathMentionSearchKey);
  }
  const [previousPathMentionSearchKey, setPreviousPathMentionSearchKey] =
    useState(pathMentionSearchKey);
  if (previousPathMentionSearchKey !== pathMentionSearchKey) {
    setPreviousPathMentionSearchKey(pathMentionSearchKey);
    pathSearchRequestIdRef.current += 1;
    if (!pathMentionSearchKey) {
      setProjectFileEntries([]);
      setFileMentionsLoading(false);
      setFileMentionsError(null);
    } else if (pathMentionCachedEntries) {
      setProjectFileEntries((prev) =>
        sameFileMentionArray(prev, pathMentionCachedEntries)
          ? prev
          : pathMentionCachedEntries,
      );
      setFileMentionsLoading(false);
      setFileMentionsError(null);
    } else {
      setProjectFileEntries(stripStaleMatchMetadata);
      setFileMentionsLoading(true);
      setFileMentionsError(null);
    }
  }

  useEffect(() => {
    if (!pathMentionSearchKey || pathMentionCachedEntries) {
      return;
    }

    const cacheKey = pathMentionSearchKey;
    const requestId = pathSearchRequestIdRef.current;

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      let request = pathSearchInFlightRef.current.get(cacheKey);
      if (!request) {
        request = searchFilesForMentions({
          roots: pathMentionSearchRoots,
          query: pathMentionSearchQuery,
          maxResults: FILE_MENTION_SEARCH_LIMIT,
        }).finally(() => {
          pathSearchInFlightRef.current.delete(cacheKey);
        });
        pathSearchInFlightRef.current.set(cacheKey, request);
      }

      void request
        .then((entries) => {
          rememberPathSearchEntries(
            pathSearchCacheRef.current,
            cacheKey,
            entries,
          );
          if (cancelled || pathSearchRequestIdRef.current !== requestId) return;
          setProjectFileEntries((prev) =>
            sameFileMentionArray(prev, entries) ? prev : entries,
          );
          setFileMentionsLoading(false);
        })
        .catch((error) => {
          if (cancelled || pathSearchRequestIdRef.current !== requestId) return;
          console.error("Failed to search project files for mentions:", error);
          setProjectFileEntries(stripStaleMatchMetadata);
          setFileMentionsError("load-error");
          setFileMentionsLoading(false);
        });
    }, FILE_MENTION_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    pathMentionSearchRoots,
    pathMentionCachedEntries,
    pathMentionSearchQuery,
    pathMentionSearchKey,
  ]);

  // ---- post-selection cursor placement ------------------------------------
  // After a mention is confirmed we update `text` via setState. A useEffect
  // watches for a pending cursor position and applies focus + cursor once
  // React has flushed the new text into the textarea.

  const pendingCursorRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text triggers the effect after setText flushes
  useEffect(() => {
    if (pendingCursorRef.current == null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    ta.setSelectionRange(pos, pos);
  }, [text, textareaRef]);

  // ---- selection handlers ------------------------------------------------

  const handlePersonaMentionSelect = useCallback(
    (persona: Persona) => {
      const activePersona = activePersonaId
        ? personas.find((candidate) => candidate.id === activePersonaId)
        : undefined;
      let nextText = text;
      let nextMentionStartIndex = mentionStartIndex;
      if (activePersona && activePersona.id !== persona.id) {
        const activeMention = `@${activePersona.displayName}`;
        const activeMentionIndex = text.indexOf(activeMention);
        if (
          activeMentionIndex >= 0 &&
          activeMentionIndex !== mentionStartIndex
        ) {
          let removeStart = activeMentionIndex;
          let removeEnd = activeMentionIndex + activeMention.length;
          if (text[removeEnd] === " ") {
            removeEnd += 1;
          } else if (removeStart > 0 && text[removeStart - 1] === " ") {
            removeStart -= 1;
          }
          nextText = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
          if (removeStart < mentionStartIndex) {
            nextMentionStartIndex -= removeEnd - removeStart;
          }
        }
      }
      const { newText, cursorPosition } = replaceMentionQuery(
        nextText,
        nextMentionStartIndex,
        mentionQuery,
        `@${persona.displayName}`,
      );
      pendingCursorRef.current = cursorPosition;
      registerCompletedMention(persona.displayName);
      setText(newText);
      closeMention();
      onPersonaChange?.(persona.id);
    },
    [
      activePersonaId,
      personas,
      text,
      mentionStartIndex,
      mentionQuery,
      closeMention,
      onPersonaChange,
      registerCompletedMention,
      setText,
    ],
  );

  const handleFileMentionSelect = useCallback(
    (file: FileMentionItem) => {
      if (onFileMentionSelect) {
        const { newText, cursorPosition } = removeMentionQuery(
          text,
          mentionStartIndex,
          mentionQuery,
        );
        pendingCursorRef.current = cursorPosition;
        setText(newText);
        closeMention();
        onFileMentionSelect(file);
        return;
      }

      const before = text.slice(0, mentionStartIndex);
      const after = text.slice(mentionStartIndex + 1 + mentionQuery.length);
      const inserted = `@${file.resolvedPath.trim()}`;
      const newText = `${before}${inserted} ${after}`;
      pendingCursorRef.current = before.length + inserted.length + 1;
      registerCompletedMention(file.resolvedPath);
      setText(newText);
      closeMention();
    },
    [
      text,
      mentionStartIndex,
      mentionQuery,
      closeMention,
      onFileMentionSelect,
      registerCompletedMention,
      setText,
    ],
  );

  const handleFileMentionComplete = useCallback(
    (file: FileMentionItem) => {
      const before = text.slice(0, mentionStartIndex);
      const after = text.slice(mentionStartIndex + 1 + mentionQuery.length);
      const inserted = `@${withTrailingPathSeparator(file.resolvedPath)}`;
      const newText = `${before}${inserted}${after}`;
      const cursorPosition = before.length + inserted.length;
      pendingCursorRef.current = cursorPosition;
      setText(newText);
      detectMention(newText, cursorPosition);
    },
    [text, mentionStartIndex, mentionQuery, detectMention, setText],
  );

  const handleSkillMentionSelect = useCallback(
    (skill: SkillMentionItem) => {
      const { newText, cursorPosition } = replaceMentionQuery(
        text,
        mentionStartIndex,
        mentionQuery,
        `/${skill.name}`,
      );
      pendingCursorRef.current = cursorPosition;
      setText(newText);
      closeMention();
      onSkillMentionSelect?.(skill);
    },
    [
      text,
      mentionStartIndex,
      mentionQuery,
      closeMention,
      onSkillMentionSelect,
      setText,
    ],
  );

  const handleMentionConfirm = useCallback(
    (item: MentionItem, options?: { completeDirectories?: boolean }) => {
      if (item.type === "persona") {
        handlePersonaMentionSelect(item.persona);
      } else if (item.type === "skill") {
        handleSkillMentionSelect(item.skill);
      } else if (
        options?.completeDirectories &&
        isCompletablePathMention(item.file)
      ) {
        handleFileMentionComplete(item.file);
      } else {
        handleFileMentionSelect(item.file);
      }
    },
    [
      handlePersonaMentionSelect,
      handleSkillMentionSelect,
      handleFileMentionComplete,
      handleFileMentionSelect,
    ],
  );

  return {
    fileMentionItems,
    skillMentionItems,
    mentionOpen,
    mentionTrigger,
    atMentionCategory,
    mentionQuery,
    mentionStartIndex,
    mentionSelectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    fileMentionsLoading,
    fileMentionsError,
    expandSkillSlashCommand: (message: string) =>
      skillsEnabled
        ? expandSkillSlashCommand(message, skillMentionItems)
        : null,
    resolveSkillSlashCommand: (message: string) =>
      skillsEnabled
        ? resolveSkillSlashCommand(message, skillMentionItems)
        : null,
    detectMention,
    closeMention,
    dismissMention,
    navigateMention,
    navigateAtMentionCategory,
    setAtMentionCategory,
    handleMentionCategoryKey,
    confirmMention,
    handlePersonaMentionSelect,
    handleSkillMentionSelect,
    handleFileMentionSelect,
    handleFileMentionComplete,
    handleMentionConfirm,
  };
}
