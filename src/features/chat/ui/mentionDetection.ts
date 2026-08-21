import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Fzf } from "fzf";
import { isReservedSlashCommand } from "@/features/skills/lib/skillChatPrompt";
import type { AtMentionDefaultCategory } from "@/features/chat/lib/mentionPreference";
import type { FileMentionMatchHighlight } from "@/shared/api/system";
import type { Persona } from "@/shared/types/agents";

const MAX_TEXT_MENTION_QUERY_LENGTH = 50;
const MAX_PATH_MENTION_QUERY_LENGTH = 256;

function fuzzyMatchIndices(query: string, target: string): number[] | null {
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (query[qi] === target[ti]) {
      indices.push(ti);
      qi++;
    }
  }
  return qi === query.length ? indices : null;
}

export function fuzzyMatch(query: string, target: string): boolean {
  return fuzzyMatchIndices(query, target) !== null;
}

// Mirrors the backend's highlight policy: indices are only safe to render
// when string positions are unambiguous, i.e. pure ASCII.
function isAsciiString(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
  return /^[\x00-\x7F]*$/.test(value);
}

export interface FileMentionItem {
  resolvedPath: string;
  displayPath: string;
  filename: string;
  kind: "file" | "folder" | "path";
  source: "project" | "session" | "home" | "filesystem";
  shortcut?: "projectRoot" | "home" | "filesystemRoot";
  /** Match tier assigned by the native matcher (lower is better). */
  matchRank?: number;
  matchHighlight?: FileMentionMatchHighlight;
}

export interface SkillMentionItem {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
  instructions?: string;
  fileLocation?: string;
}

type IndexedSkillMention = {
  skill: SkillMentionItem;
  index: number;
};

export type MentionItem =
  | { type: "persona"; persona: Persona }
  | { type: "skill"; skill: SkillMentionItem }
  | { type: "file"; file: FileMentionItem };
export type MentionTrigger = "@" | "/";
export type AtMentionCategory = "agents" | "files" | "skills";

type MentionCategoryKeyEvent = Pick<KeyboardEvent, "code" | "key" | "shiftKey">;
const MENTION_CATEGORIES: AtMentionCategory[] = ["agents", "files", "skills"];

function nextMentionCategory(
  category: AtMentionCategory,
  direction: "next" | "previous",
): AtMentionCategory {
  const currentIndex = MENTION_CATEGORIES.indexOf(category);
  const delta = direction === "next" ? 1 : -1;
  return MENTION_CATEGORIES[
    (currentIndex + delta + MENTION_CATEGORIES.length) %
      MENTION_CATEGORIES.length
  ];
}

function nextAtMentionCategory(
  category: AtMentionCategory,
  direction: "next" | "previous" = "next",
): AtMentionCategory {
  if (category === "skills") {
    return direction === "next" ? "agents" : "files";
  }
  return category === "files" ? "agents" : "files";
}

function isTokenBoundary(value: string, index: number): boolean {
  return index === 0 || /\s/.test(value[index - 1] ?? "");
}

function findLastAtMentionTrigger(value: string): number {
  let index = value.lastIndexOf("@");
  while (index >= 0) {
    if (isTokenBoundary(value, index)) return index;
    index = value.lastIndexOf("@", index - 1);
  }
  return -1;
}

function findLastSlashMentionTrigger(value: string): number {
  let index = value.lastIndexOf("/");
  while (index >= 0) {
    if (isTokenBoundary(value, index)) return index;
    index = value.lastIndexOf("/", index - 1);
  }
  return -1;
}

function isPathShapedSlashMentionQuery(query: string): boolean {
  return query.includes("/") || query.includes("\\");
}

function isPromptStart(value: string, index: number): boolean {
  return value.slice(0, index).trim().length === 0;
}

type ScoredFileMention = {
  file: FileMentionItem;
  score: number;
  index: number;
};

function isProjectRootMention(file: FileMentionItem): boolean {
  return file.shortcut === "projectRoot";
}

function isPathLikeMentionQuery(query: string): boolean {
  const firstWhitespaceIndex = query.search(/\s/);
  const firstToken =
    firstWhitespaceIndex === -1 ? query : query.slice(0, firstWhitespaceIndex);

  return (
    query.startsWith("/") ||
    query.startsWith("~") ||
    query.includes("/") ||
    query.includes("\\") ||
    /^[a-z]:[\\/]/i.test(query) ||
    firstToken.includes(".")
  );
}

function allowsSpacesInPathMentionQuery(query: string): boolean {
  const firstWhitespaceIndex = query.search(/\s/);
  const firstToken =
    firstWhitespaceIndex === -1 ? query : query.slice(0, firstWhitespaceIndex);

  return (
    firstToken.startsWith("/") ||
    firstToken.startsWith("~") ||
    firstToken.includes("/") ||
    firstToken.includes("\\") ||
    /^[a-z]:[\\/]/i.test(firstToken)
  );
}

function maxMentionQueryLength(query: string): number {
  return isPathLikeMentionQuery(query)
    ? MAX_PATH_MENTION_QUERY_LENGTH
    : MAX_TEXT_MENTION_QUERY_LENGTH;
}

function pathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function withoutTrailingPathSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function searchableFilename(file: FileMentionItem): string {
  if (file.shortcut === "home") {
    return pathBasename(file.resolvedPath).toLowerCase();
  }
  if (file.shortcut === "filesystemRoot") {
    return "";
  }
  return file.filename.toLowerCase();
}

function pathMentionScore(
  query: string,
  file: FileMentionItem,
  hasProjectRoot: boolean,
): number | null {
  if (!query) {
    if (isProjectRootMention(file)) return 1;
    if (file.shortcut === "home") return 2;
    if (file.shortcut === "filesystemRoot" && !hasProjectRoot) return 3;
    return null;
  }
  if (query === "/") return file.source === "filesystem" ? 1 : null;
  if (/^[a-z]:[\\/]?$/.test(query)) {
    return file.source === "filesystem" &&
      file.resolvedPath.toLowerCase().startsWith(query)
      ? 1
      : null;
  }
  if (file.shortcut === "home" && ["~", "~/", "~\\"].includes(query)) {
    return 1;
  }
  // Backend-searched entries arrive already matched and tiered by the native
  // matcher, which handles cases the local rules can't (unicode
  // normalization, camelCase boundaries). Trust its rank instead of
  // re-deriving one.
  if (file.matchRank != null) {
    return Math.min(file.matchRank + 1, 5);
  }
  const queryIsPathLike = isPathLikeMentionQuery(query);
  const filename = searchableFilename(file);
  const displayPath = file.shortcut ? "" : file.displayPath.toLowerCase();
  const resolvedPath = queryIsPathLike
    ? file.resolvedPath.toLowerCase().replace(/\\/g, "/")
    : "";
  const searchablePaths = [displayPath, resolvedPath].filter(Boolean);
  const searchableFields = [filename, ...searchablePaths].filter(Boolean);
  const segments = [displayPath, resolvedPath]
    .filter(Boolean)
    .join("/")
    .split(/[\\/]+/);
  if (
    isProjectRootMention(file) &&
    filename &&
    withoutTrailingPathSeparators(query) === filename
  ) {
    return 0;
  }
  if (filename === query) return 1;
  if (displayPath === query || resolvedPath === query) return 1;
  if (filename.startsWith(query)) return 2;
  if (displayPath.startsWith(query) || resolvedPath.startsWith(query)) return 2;
  if (segments.some((segment) => segment.startsWith(query))) return 3;
  if (
    query.length >= 2 &&
    searchableFields.some((field) => field.includes(query))
  ) {
    return 4;
  }
  // Keep local fuzzy matching filename-only. Broader path fuzzy matching is
  // handled by the backend for indexed project files.
  if (query.length >= 3 && fuzzyMatch(query, filename)) return 5;
  return null;
}

/**
 * Entries the backend didn't score (session artifacts, files outside the
 * project roots) have no highlight; derive one locally so every listed
 * match highlights consistently. Same policy as the backend: ASCII only,
 * since indices are only unambiguous there.
 */
function withMatchHighlight(
  query: string,
  file: FileMentionItem,
): FileMentionItem {
  if (file.matchHighlight || file.shortcut || !query || !isAsciiString(query)) {
    return file;
  }
  for (const target of ["filename", "path"] as const) {
    const text = target === "filename" ? file.filename : file.displayPath;
    if (!isAsciiString(text)) continue;
    const position = text.toLowerCase().indexOf(query);
    const indices =
      position >= 0
        ? Array.from(query, (_, i) => position + i)
        : query.length >= 3
          ? fuzzyMatchIndices(query, text.toLowerCase())
          : null;
    if (indices) return { ...file, matchHighlight: { target, indices } };
  }
  return file;
}

function isScoredFileMention(
  entry:
    | ScoredFileMention
    | { file: FileMentionItem; score: null; index: number },
): entry is ScoredFileMention {
  return entry.score != null;
}

/**
 * Within a tier, order by the backend's native rank when present. Local
 * entries (chat-context files outside the project roots) get rank parity
 * with the backend's filename-fuzzy tier when their filename fuzzy-matched
 * (tier 5); anything else local sorts after backend-verified matches. The
 * final tie-break preserves incoming order, which is the backend's own
 * scoring for backend entries.
 */
function effectiveMatchRank(entry: ScoredFileMention): number {
  return entry.file.matchRank ?? (entry.score === 5 ? 4 : 99);
}

function compareScoredFileMentions(
  a: ScoredFileMention,
  b: ScoredFileMention,
): number {
  return (
    a.score - b.score ||
    effectiveMatchRank(a) - effectiveMatchRank(b) ||
    a.index - b.index
  );
}

function fileMentionKey(file: FileMentionItem): string {
  return `file:${file.resolvedPath}:${file.shortcut ?? ""}`;
}

/**
 * True when the text after `@` is a mention the user already selected from
 * the dropdown (optionally followed by more typed text). Path-like queries
 * are allowed to contain spaces, so without this check everything typed
 * after a completed selection would keep re-triggering the search.
 */
function isCompletedMentionQuery(
  query: string,
  completed: ReadonlySet<string>,
): boolean {
  if (completed.has(query)) return true;
  for (const text of completed) {
    if (
      query.length > text.length &&
      query.startsWith(text) &&
      /\s/.test(query[text.length])
    ) {
      return true;
    }
  }
  return false;
}

function mentionItemKeys(
  filteredFiles: FileMentionItem[],
  filteredPersonas: Persona[],
  filteredSkills: SkillMentionItem[],
): string[] {
  return [
    ...filteredFiles.map(fileMentionKey),
    ...filteredPersonas.map((persona) => `persona:${persona.id}`),
    ...filteredSkills.map((skill) => `skill:${skill.id}`),
  ];
}

function sameMentionItemKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function rankSkillMentions(
  skills: SkillMentionItem[],
  query: string,
): SkillMentionItem[] {
  const trimmedQuery = query.trim();
  const q = trimmedQuery.toLowerCase();
  if (!q) return skills;

  const indexedSkills: IndexedSkillMention[] = skills.map((skill, index) => ({
    skill,
    index,
  }));
  const fzf = new Fzf(indexedSkills, {
    selector: ({ skill }) => skill.name,
    casing: "case-insensitive",
    sort: false,
  });
  const seenSkillIds = new Set<string>();
  const rankedSkills: SkillMentionItem[] = [];
  const appendSkill = (skill: SkillMentionItem) => {
    rankedSkills.push(skill);
    seenSkillIds.add(skill.id);
  };

  for (const result of fzf.find(trimmedQuery).sort((a, b) => {
    const aName = a.item.skill.name.toLowerCase();
    const bName = b.item.skill.name.toLowerCase();
    const aIsExact = aName === q;
    const bIsExact = bName === q;
    const aIsPrefix = aName.startsWith(q);
    const bIsPrefix = bName.startsWith(q);
    return (
      Number(bIsExact) - Number(aIsExact) ||
      Number(bIsPrefix) - Number(aIsPrefix) ||
      b.score - a.score ||
      a.item.index - b.item.index
    );
  })) {
    appendSkill(result.item.skill);
  }

  for (const { skill } of indexedSkills) {
    if (
      !seenSkillIds.has(skill.id) &&
      skill.description.toLowerCase().includes(q)
    ) {
      appendSkill(skill);
    }
  }

  for (const { skill } of indexedSkills) {
    if (
      !seenSkillIds.has(skill.id) &&
      fuzzyMatch(q, skill.sourceLabel.toLowerCase())
    ) {
      appendSkill(skill);
    }
  }

  return rankedSkills;
}

export function useMentionDetection(
  personas: Persona[] = [],
  skills: SkillMentionItem[] = [],
  files: FileMentionItem[] = [],
  defaultAtMentionCategory: AtMentionDefaultCategory = "agents",
  currentText?: string,
) {
  const [mentionState, setMentionState] = useState<{
    isOpen: boolean;
    trigger: MentionTrigger;
    category: AtMentionCategory;
    query: string;
    startIndex: number;
    selectedIndex: number;
  }>({
    isOpen: false,
    trigger: "@",
    category: "agents",
    query: "",
    startIndex: -1,
    selectedIndex: 0,
  });
  const completedMentionsRef = useRef<Set<string>>(new Set());
  const lastDetectedTextRef = useRef(currentText);
  const dismissedMentionRef = useRef<{
    trigger: MentionTrigger;
    startIndex: number;
    query: string;
  } | null>(null);
  const mentionStateRef = useRef(mentionState);
  mentionStateRef.current = mentionState;

  useEffect(() => {
    if (currentText !== lastDetectedTextRef.current) {
      dismissedMentionRef.current = null;
      lastDetectedTextRef.current = currentText;
    }
  }, [currentText]);

  const registerCompletedMention = useCallback((mention: string) => {
    const trimmed = mention.trim();
    if (trimmed) {
      completedMentionsRef.current.add(trimmed);
    }
  }, []);

  const { filteredPersonas, filteredSkills, filteredFiles } = useMemo(() => {
    if (!mentionState.isOpen) {
      return {
        filteredPersonas: personas,
        filteredSkills: skills,
        filteredFiles: files,
      };
    }

    const q = mentionState.query.toLowerCase();
    const hasProjectRoot = files.some(isProjectRootMention);
    const matchingFiles = files
      .map((file, index) => ({
        file,
        score: pathMentionScore(q, file, hasProjectRoot),
        index,
      }))
      .filter(isScoredFileMention)
      .sort(compareScoredFileMentions)
      .map((entry) => withMatchHighlight(q, entry.file));
    if (mentionState.category === "files") {
      return {
        filteredPersonas: [],
        filteredSkills: [],
        filteredFiles: matchingFiles,
      };
    }

    if (mentionState.category === "skills") {
      const matchingSkills = rankSkillMentions(skills, mentionState.query);

      return {
        filteredPersonas: [],
        filteredSkills: matchingSkills,
        filteredFiles: [],
      };
    }

    return {
      filteredPersonas: q
        ? personas.filter((p) => fuzzyMatch(q, p.displayName.toLowerCase()))
        : personas,
      filteredSkills: [],
      filteredFiles: [],
    };
  }, [
    personas,
    skills,
    files,
    mentionState.isOpen,
    mentionState.query,
    mentionState.category,
  ]);

  const totalCount =
    filteredFiles.length + filteredPersonas.length + filteredSkills.length;
  const filteredItemKeys = useMemo(
    () => mentionItemKeys(filteredFiles, filteredPersonas, filteredSkills),
    [filteredFiles, filteredPersonas, filteredSkills],
  );
  const previousItemKeysRef = useRef<string[]>(filteredItemKeys);

  useEffect(() => {
    const previousItemKeys = previousItemKeysRef.current;
    previousItemKeysRef.current = filteredItemKeys;

    if (!mentionState.isOpen) return;

    setMentionState((prev) => {
      if (!prev.isOpen) return prev;
      if (filteredItemKeys.length === 0) {
        return prev.selectedIndex === 0 ? prev : { ...prev, selectedIndex: 0 };
      }
      if (
        prev.selectedIndex < filteredItemKeys.length &&
        sameMentionItemKeys(previousItemKeys, filteredItemKeys)
      ) {
        return prev;
      }

      const selectedKey = previousItemKeys[prev.selectedIndex];
      const selectedIndex = selectedKey
        ? filteredItemKeys.indexOf(selectedKey)
        : -1;
      return {
        ...prev,
        selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
      };
    });
  }, [filteredItemKeys, mentionState.isOpen]);

  const detectMention = useCallback(
    (value: string, cursorPos: number) => {
      lastDetectedTextRef.current = value;
      const beforeCursor = value.slice(0, cursorPos);
      const lastAt = findLastAtMentionTrigger(beforeCursor);
      const lastSlash = findLastSlashMentionTrigger(beforeCursor);

      if (lastAt === -1 && lastSlash === -1) {
        dismissedMentionRef.current = null;
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }

      const trigger: MentionTrigger = lastSlash > lastAt ? "/" : "@";
      const startIndex = trigger === "/" ? lastSlash : lastAt;
      const query = beforeCursor.slice(startIndex + 1);
      const dismissedMention = dismissedMentionRef.current;
      if (
        dismissedMention?.trigger === trigger &&
        dismissedMention.startIndex === startIndex &&
        query.startsWith(dismissedMention.query)
      ) {
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }
      dismissedMentionRef.current = null;

      if (lastSlash > lastAt) {
        if (
          (!isPromptStart(beforeCursor, lastSlash) && query.length === 0) ||
          query.includes(" ") ||
          isPathShapedSlashMentionQuery(query) ||
          query.length > MAX_TEXT_MENTION_QUERY_LENGTH ||
          isReservedSlashCommand(query)
        ) {
          if (mentionState.isOpen) closeMentionState(setMentionState);
          return;
        }

        setMentionState((prev) => ({
          isOpen: true,
          trigger: "/",
          category:
            prev.isOpen && prev.trigger === "/" ? prev.category : "skills",
          query,
          startIndex: lastSlash,
          selectedIndex:
            prev.query !== query || prev.trigger !== "/"
              ? 0
              : prev.selectedIndex,
        }));
        return;
      }

      if (isCompletedMentionQuery(query, completedMentionsRef.current)) {
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }
      const hasSpace = /\s/.test(query);
      if (
        (hasSpace && !allowsSpacesInPathMentionQuery(query)) ||
        query.length > maxMentionQueryLength(query)
      ) {
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }

      setMentionState((prev) => ({
        isOpen: true,
        trigger: "@",
        category:
          prev.isOpen && prev.trigger === "@"
            ? prev.category
            : defaultAtMentionCategory,
        query,
        startIndex: lastAt,
        selectedIndex:
          prev.query !== query || prev.trigger !== "@" ? 0 : prev.selectedIndex,
      }));
    },
    [defaultAtMentionCategory, mentionState.isOpen],
  );

  const closeMention = useCallback(() => {
    closeMentionState(setMentionState);
  }, []);

  const dismissMention = useCallback(() => {
    const current = mentionStateRef.current;
    dismissedMentionRef.current = current.isOpen
      ? {
          trigger: current.trigger,
          startIndex: current.startIndex,
          query: current.query,
        }
      : null;
    closeMentionState(setMentionState);
  }, []);

  const navigateMention = useCallback(
    (direction: "up" | "down"): boolean => {
      if (!mentionState.isOpen || totalCount === 0) return false;
      setMentionState((prev) => {
        const delta = direction === "down" ? 1 : -1;
        const next = (prev.selectedIndex + delta + totalCount) % totalCount;
        return { ...prev, selectedIndex: next };
      });
      return true;
    },
    [mentionState.isOpen, totalCount],
  );

  const setAtMentionCategory = useCallback((category: AtMentionCategory) => {
    setMentionState((prev) =>
      prev.isOpen && prev.category !== category
        ? { ...prev, category, selectedIndex: 0 }
        : prev,
    );
  }, []);

  const navigateAtMentionCategory = useCallback(
    (direction: "next" | "previous"): boolean => {
      if (!mentionState.isOpen || mentionState.trigger !== "@") return false;
      setMentionState((prev) => {
        if (!prev.isOpen || prev.trigger !== "@") return prev;
        return {
          ...prev,
          category: nextAtMentionCategory(prev.category, direction),
          selectedIndex: 0,
        };
      });
      return true;
    },
    [mentionState.isOpen, mentionState.trigger],
  );

  const handleMentionCategoryKey = useCallback(
    (event: MentionCategoryKeyEvent): boolean => {
      const current = mentionStateRef.current;
      if (!current.isOpen) return false;

      const isAtKey =
        event.key === "@" || (event.shiftKey && event.code === "Digit2");
      const isSlashKey = event.key === "/";
      if (isAtKey) {
        setMentionState((prev) =>
          prev.isOpen
            ? {
                ...prev,
                category: nextAtMentionCategory(prev.category),
                selectedIndex: 0,
              }
            : prev,
        );
        return true;
      }
      if (
        isSlashKey &&
        current.query.length === 0 &&
        current.category !== "files"
      ) {
        setMentionState((prev) =>
          prev.isOpen
            ? { ...prev, category: "skills", selectedIndex: 0 }
            : prev,
        );
        return true;
      }
      if (event.key === "ArrowRight") {
        setMentionState((prev) =>
          prev.isOpen
            ? {
                ...prev,
                category: nextMentionCategory(prev.category, "next"),
                selectedIndex: 0,
              }
            : prev,
        );
        return true;
      }
      if (event.key === "ArrowLeft") {
        setMentionState((prev) =>
          prev.isOpen
            ? {
                ...prev,
                category: nextMentionCategory(prev.category, "previous"),
                selectedIndex: 0,
              }
            : prev,
        );
        return true;
      }

      return false;
    },
    [],
  );

  const confirmMention = useCallback((): MentionItem | null => {
    if (!mentionState.isOpen || totalCount === 0) return null;
    const idx = mentionState.selectedIndex;
    if (idx < filteredFiles.length) {
      return { type: "file", file: filteredFiles[idx] };
    }
    const personaIdx = idx - filteredFiles.length;
    if (personaIdx < filteredPersonas.length) {
      return { type: "persona", persona: filteredPersonas[personaIdx] };
    }
    const skillIdx = personaIdx - filteredPersonas.length;
    if (skillIdx < filteredSkills.length) {
      return { type: "skill", skill: filteredSkills[skillIdx] };
    }
    return null;
  }, [
    mentionState.isOpen,
    mentionState.selectedIndex,
    totalCount,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
  ]);

  return {
    mentionOpen: mentionState.isOpen,
    mentionTrigger: mentionState.trigger,
    atMentionCategory: mentionState.category,
    mentionQuery: mentionState.query,
    mentionStartIndex: mentionState.startIndex,
    mentionSelectedIndex: mentionState.selectedIndex,
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
  };
}

function closeMentionState(
  setMentionState: Dispatch<
    SetStateAction<{
      isOpen: boolean;
      trigger: MentionTrigger;
      category: AtMentionCategory;
      query: string;
      startIndex: number;
      selectedIndex: number;
    }>
  >,
) {
  setMentionState({
    isOpen: false,
    trigger: "@",
    category: "agents",
    query: "",
    startIndex: -1,
    selectedIndex: 0,
  });
}
