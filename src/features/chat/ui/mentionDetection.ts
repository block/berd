import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { isReservedSlashCommand } from "@/features/skills/lib/skillChatPrompt";
import type { Persona } from "@/shared/types/agents";

const MAX_TEXT_MENTION_QUERY_LENGTH = 50;
const MAX_PATH_MENTION_QUERY_LENGTH = 256;

export function fuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (query[qi] === target[ti]) qi++;
  }
  return qi === query.length;
}

export interface FileMentionItem {
  resolvedPath: string;
  displayPath: string;
  filename: string;
  kind: "file" | "folder" | "path";
  source: "project" | "session" | "home" | "filesystem";
  shortcut?: "projectRoot" | "home" | "filesystemRoot";
}

export interface SkillMentionItem {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
}

export type MentionItem =
  | { type: "persona"; persona: Persona }
  | { type: "skill"; skill: SkillMentionItem }
  | { type: "file"; file: FileMentionItem };

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
  return (
    query.startsWith("/") ||
    query.startsWith("~") ||
    query.includes("/") ||
    query.includes("\\") ||
    /^[a-z]:[\\/]/i.test(query)
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
  const queryIsPathLike = isPathLikeMentionQuery(query);
  const filename = searchableFilename(file);
  const displayPath = file.shortcut ? "" : file.displayPath.toLowerCase();
  const resolvedPath = queryIsPathLike
    ? file.resolvedPath.toLowerCase().replace(/\\/g, "/")
    : "";
  const searchablePath = [filename, displayPath, resolvedPath]
    .filter(Boolean)
    .join(" ");
  const segments = [displayPath, resolvedPath]
    .filter(Boolean)
    .join("/")
    .split(/[\\/]+/);
  if (filename === query) return 1;
  if (displayPath === query || resolvedPath === query) return 1;
  if (filename.startsWith(query)) return 2;
  if (displayPath.startsWith(query) || resolvedPath.startsWith(query)) return 2;
  if (segments.some((segment) => segment.startsWith(query))) return 3;
  if (query.length >= 2 && searchablePath.includes(query)) return 4;
  if (query.length >= 3 && fuzzyMatch(query, searchablePath)) return 5;
  return null;
}

function isScoredFileMention(
  entry:
    | ScoredFileMention
    | { file: FileMentionItem; score: null; index: number },
): entry is ScoredFileMention {
  return entry.score != null;
}

function compareScoredFileMentions(
  a: ScoredFileMention,
  b: ScoredFileMention,
): number {
  return (
    a.score - b.score ||
    a.file.displayPath.localeCompare(b.file.displayPath) ||
    a.index - b.index
  );
}

function fileMentionKey(file: FileMentionItem): string {
  return `file:${file.resolvedPath}:${file.shortcut ?? ""}`;
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

export function useMentionDetection(
  personas: Persona[] = [],
  skills: SkillMentionItem[] = [],
  files: FileMentionItem[] = [],
) {
  const [mentionState, setMentionState] = useState<{
    isOpen: boolean;
    trigger: "@" | "/";
    query: string;
    startIndex: number;
    selectedIndex: number;
  }>({
    isOpen: false,
    trigger: "@",
    query: "",
    startIndex: -1,
    selectedIndex: 0,
  });

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
      .map((entry) => entry.file);
    const matchesSkill = (skill: SkillMentionItem) =>
      fuzzyMatch(q, skill.name.toLowerCase()) ||
      skill.description.toLowerCase().includes(q) ||
      fuzzyMatch(q, skill.sourceLabel.toLowerCase());
    const matchingSkills = q ? skills.filter(matchesSkill) : skills;

    if (mentionState.trigger === "/") {
      return {
        filteredPersonas: [],
        filteredSkills: matchingSkills,
        filteredFiles: [],
      };
    }

    if (!q) {
      return {
        filteredPersonas: personas,
        filteredSkills: skills,
        filteredFiles: matchingFiles,
      };
    }

    return {
      filteredPersonas: personas.filter((p) =>
        fuzzyMatch(q, p.displayName.toLowerCase()),
      ),
      filteredSkills: matchingSkills,
      filteredFiles: matchingFiles,
    };
  }, [
    personas,
    skills,
    files,
    mentionState.isOpen,
    mentionState.query,
    mentionState.trigger,
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
      const beforeCursor = value.slice(0, cursorPos);
      const lastAt = beforeCursor.lastIndexOf("@");
      const slashAtStart = beforeCursor.startsWith("/") ? 0 : -1;

      if (lastAt === -1 && slashAtStart === -1) {
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }

      if (slashAtStart === 0 && lastAt === -1) {
        const query = beforeCursor.slice(1);
        if (
          query.includes(" ") ||
          query.length > MAX_TEXT_MENTION_QUERY_LENGTH ||
          isReservedSlashCommand(query)
        ) {
          if (mentionState.isOpen) closeMentionState(setMentionState);
          return;
        }

        setMentionState((prev) => ({
          isOpen: true,
          trigger: "/",
          query,
          startIndex: 0,
          selectedIndex:
            prev.query !== query || prev.trigger !== "/"
              ? 0
              : prev.selectedIndex,
        }));
        return;
      }

      if (lastAt > 0 && !/\s/.test(beforeCursor[lastAt - 1])) {
        if (mentionState.isOpen) closeMentionState(setMentionState);
        return;
      }

      const query = beforeCursor.slice(lastAt + 1);
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
        query,
        startIndex: lastAt,
        selectedIndex:
          prev.query !== query || prev.trigger !== "@" ? 0 : prev.selectedIndex,
      }));
    },
    [mentionState.isOpen],
  );

  const closeMention = useCallback(() => {
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
    mentionQuery: mentionState.query,
    mentionStartIndex: mentionState.startIndex,
    mentionSelectedIndex: mentionState.selectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    detectMention,
    closeMention,
    navigateMention,
    confirmMention,
  };
}

function closeMentionState(
  setMentionState: Dispatch<
    SetStateAction<{
      isOpen: boolean;
      trigger: "@" | "/";
      query: string;
      startIndex: number;
      selectedIndex: number;
    }>
  >,
) {
  setMentionState({
    isOpen: false,
    trigger: "@",
    query: "",
    startIndex: -1,
    selectedIndex: 0,
  });
}
