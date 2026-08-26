import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, User } from "lucide-react";
import { IconBook, IconFile, IconFolder } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { AvatarVisual } from "@/shared/ui/avatar-visual";
import { PopoverContent } from "@/shared/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { Persona } from "@/shared/types/agents";
import type {
  AtMentionCategory,
  FileMentionItem,
  MentionItem,
  SkillMentionItem,
} from "./mentionDetection";
export { fuzzyMatch, useMentionDetection } from "./mentionDetection";
export type {
  AtMentionCategory,
  FileMentionItem,
  MentionItem,
  SkillMentionItem,
} from "./mentionDetection";

interface MentionAutocompleteProps {
  /** Pre-filtered personas from the hook. */
  filteredPersonas: Persona[];
  /** Pre-filtered skills from the hook. */
  filteredSkills?: SkillMentionItem[];
  /** Pre-filtered files from the hook. */
  filteredFiles?: FileMentionItem[];
  isOpen: boolean;
  onSelectPersona: (persona: Persona) => void;
  onSelectSkill?: (skill: SkillMentionItem) => void;
  onSelectFile?: (file: FileMentionItem) => void;
  onDismiss?: () => void;
  selectedIndex?: number;
  listboxId?: string;
  atCategory?: AtMentionCategory;
  onAtCategoryChange?: (category: AtMentionCategory) => void;
  /** Hide the agents/files/skills tab strip for single-category surfaces. */
  showCategoryTabs?: boolean;
  pathsLoading?: boolean;
  pathsError?: string | null;
}

export function MentionAutocomplete({
  filteredPersonas,
  filteredSkills = [],
  filteredFiles = [],
  isOpen,
  onSelectPersona,
  onSelectSkill,
  onSelectFile,
  onDismiss,
  selectedIndex: controlledIndex,
  listboxId = "mention-autocomplete-listbox",
  atCategory = "agents",
  onAtCategoryChange,
  showCategoryTabs = true,
  pathsLoading = false,
  pathsError = null,
}: MentionAutocompleteProps) {
  const { t } = useTranslation("chat");
  const [internalIndex, setInternalIndex] = useState(0);
  const selectedIndex = controlledIndex ?? internalIndex;
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Scroll the active item into view when selectedIndex changes
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const items: MentionItem[] = useMemo(() => {
    const result: MentionItem[] = [];
    if (atCategory === "skills") {
      for (const skill of filteredSkills) {
        result.push({ type: "skill" as const, skill });
      }
      return result;
    }
    if (atCategory === "files") {
      for (const f of filteredFiles) {
        result.push({ type: "file" as const, file: f });
      }
      return result;
    }
    for (const p of filteredPersonas) {
      result.push({ type: "persona" as const, persona: p });
    }
    return result;
  }, [atCategory, filteredPersonas, filteredSkills, filteredFiles]);

  const handleSelect = useCallback(
    (item: MentionItem) => {
      if (item.type === "persona") {
        onSelectPersona(item.persona);
      } else if (item.type === "skill") {
        onSelectSkill?.(item.skill);
      } else {
        onSelectFile?.(item.file);
      }
    },
    [onSelectPersona, onSelectSkill, onSelectFile],
  );

  if (!isOpen) return null;

  const showFileStates = atCategory === "files";
  const visibleFiles = showFileStates ? filteredFiles : [];
  const visiblePersonas = atCategory === "agents" ? filteredPersonas : [];
  const visibleSkills = atCategory === "skills" ? filteredSkills : [];
  const hasResults = items.length > 0;
  const showEmpty =
    (!showFileStates || (!pathsLoading && !pathsError)) && !hasResults;
  // Both helpers return the rendered text together with its highlight
  // indices, so substituted (translated) strings can never carry indices
  // that were computed against the original filename/path.
  const getFileLabel = (
    file: FileMentionItem,
  ): { text: string; indices?: number[] } => {
    if (file.shortcut === "home") {
      return { text: t("mention.homeFolder") };
    }
    if (file.shortcut === "filesystemRoot") {
      return { text: t("mention.filesystemRoot") };
    }
    return {
      text: file.filename,
      indices:
        file.matchHighlight?.target === "filename"
          ? file.matchHighlight.indices
          : undefined,
    };
  };
  const getFileDescription = (
    file: FileMentionItem,
  ): { text: string; indices?: number[] } => {
    if (file.shortcut === "projectRoot") {
      return { text: t("mention.projectRoot") };
    }
    return {
      text: file.displayPath,
      indices:
        file.matchHighlight?.target === "path"
          ? file.matchHighlight.indices
          : undefined,
    };
  };

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={4}
      className="w-72 p-2"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onPointerDownOutside={() => onDismiss?.()}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        onDismiss?.();
      }}
    >
      {showCategoryTabs ? (
        <Tabs
          value={atCategory}
          onValueChange={(value) =>
            onAtCategoryChange?.(value as AtMentionCategory)
          }
          className="gap-0 pb-2"
        >
          <TabsList variant="buttons" className="w-full justify-start gap-1">
            <MentionTabTrigger
              value="agents"
              label={t("mention.title")}
              symbol="@"
              onSelect={onAtCategoryChange}
            />
            <MentionTabTrigger
              value="files"
              label={t("mention.filesTitle")}
              symbol="@"
              onSelect={onAtCategoryChange}
            />
            <MentionTabTrigger
              value="skills"
              label={t("mention.skillsTitle")}
              symbol="/"
              onSelect={onAtCategoryChange}
            />
          </TabsList>
        </Tabs>
      ) : null}
      <div className="h-56 overflow-y-auto overscroll-contain scrollbar-none">
        <div
          role="listbox"
          id={listboxId}
          aria-label={t("mention.ariaLabel")}
          className="space-y-0.5 pb-2"
        >
          {visibleFiles.map((file, i) => {
            const globalIndex = i;
            return (
              <button
                key={file.resolvedPath}
                ref={(el) => {
                  if (el) itemRefs.current.set(globalIndex, el);
                  else itemRefs.current.delete(globalIndex);
                }}
                type="button"
                role="option"
                id={`${listboxId}-option-${globalIndex}`}
                tabIndex={-1}
                aria-selected={globalIndex === selectedIndex}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                  globalIndex === selectedIndex
                    ? "bg-accent text-foreground"
                    : "text-foreground hover:bg-accent",
                )}
                onClick={() => handleSelect({ type: "file", file })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center">
                  {file.kind !== "file" ? (
                    <IconFolder className="size-4 shrink-0" />
                  ) : (
                    <IconFile className="size-4 shrink-0" />
                  )}
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-normal">
                    <HighlightedMatchText {...getFileLabel(file)} />
                  </span>
                  <span className="truncate text-xs text-muted-foreground/60">
                    <HighlightedMatchText {...getFileDescription(file)} />
                  </span>
                </div>
              </button>
            );
          })}
          {visiblePersonas.map((persona, i) => {
            const globalIndex = i;
            return (
              <button
                key={persona.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(globalIndex, el);
                  else itemRefs.current.delete(globalIndex);
                }}
                type="button"
                role="option"
                id={`${listboxId}-option-${globalIndex}`}
                tabIndex={-1}
                aria-selected={globalIndex === selectedIndex}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                  globalIndex === selectedIndex
                    ? "bg-accent text-foreground"
                    : "text-foreground hover:bg-accent",
                )}
                onClick={() => handleSelect({ type: "persona", persona })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                <MentionAvatar persona={persona} />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-normal">
                    {persona.displayName}
                  </span>
                  {persona.provider && (
                    <span className="text-xs text-muted-foreground/60">
                      {persona.provider}
                      {persona.model
                        ? ` / ${persona.model.split("-").slice(0, 2).join("-")}`
                        : ""}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {visibleSkills.map((skill, i) => {
            const globalIndex = i;
            return (
              <button
                key={skill.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(globalIndex, el);
                  else itemRefs.current.delete(globalIndex);
                }}
                type="button"
                role="option"
                id={`${listboxId}-option-${globalIndex}`}
                tabIndex={-1}
                aria-selected={globalIndex === selectedIndex}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                  globalIndex === selectedIndex
                    ? "bg-accent text-foreground"
                    : "text-foreground hover:bg-accent",
                )}
                onClick={() => handleSelect({ type: "skill", skill })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center">
                  <IconBook className="size-4 shrink-0" />
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-normal">{skill.name}</span>
                  <span className="truncate text-xs text-muted-foreground/60">
                    {skill.description || skill.sourceLabel}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {showFileStates && pathsLoading && (
          <div
            role="status"
            aria-live="polite"
            className="px-2 py-2 text-sm text-muted-foreground"
          >
            {t("mention.loadingPaths")}
          </div>
        )}
        {showFileStates && pathsError && (
          <div
            role="status"
            aria-live="polite"
            className="px-2 py-2 text-sm text-muted-foreground"
          >
            {t("mention.loadError")}
          </div>
        )}
        {showEmpty && (
          <div
            role="status"
            aria-live="polite"
            className="px-2 py-2 text-sm text-muted-foreground"
          >
            {t("mention.noMatches")}
          </div>
        )}
      </div>
    </PopoverContent>
  );
}

function MentionTabTrigger({
  value,
  label,
  symbol,
  onSelect,
}: {
  value: AtMentionCategory;
  label: string;
  symbol: "@" | "/";
  onSelect?: (category: AtMentionCategory) => void;
}) {
  return (
    <TabsTrigger
      value={value}
      variant="buttons"
      className="h-7 flex-none rounded-sm px-2.5 text-xs"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect?.(value)}
    >
      <span>{label}</span>
      <span aria-hidden="true" className="text-muted-foreground/35">
        {symbol}
      </span>
    </TabsTrigger>
  );
}

// ---------------------------------------------------------------------------
// Match highlighting
// ---------------------------------------------------------------------------

/**
 * Renders `text` with the characters at `indices` (char positions, as
 * reported by the backend matcher) emphasized, fzf-style. Indices are
 * char-based rather than UTF-16 code units, hence `Array.from`. Consecutive
 * matched characters render as one span so the accessible name stays intact.
 */
function HighlightedMatchText({
  text,
  indices,
}: {
  text: string;
  indices?: number[];
}) {
  if (!indices?.length) return <>{text}</>;
  const matched = new Set(indices);
  const chars = Array.from(text);
  const parts: ReactNode[] = [];
  let runStart = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && matched.has(i) === matched.has(runStart)) {
      continue;
    }
    const run = chars.slice(runStart, i).join("");
    parts.push(
      matched.has(runStart) ? (
        <span key={runStart} className="text-primary">
          {run}
        </span>
      ) : (
        run
      ),
    );
    runStart = i;
  }
  return <>{parts}</>;
}

// ---------------------------------------------------------------------------
// Avatar helper
// ---------------------------------------------------------------------------

function MentionAvatar({ persona }: { persona: Persona }) {
  const fallback = (
    <div
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-full",
        persona.isBuiltin
          ? "bg-foreground/10 text-foreground"
          : "bg-primary/10 text-primary",
      )}
    >
      {persona.isBuiltin ? (
        <Sparkles className="h-3.5 w-3.5" />
      ) : (
        <User className="h-3.5 w-3.5" />
      )}
    </div>
  );

  return (
    <AvatarVisual
      avatar={persona.avatar}
      alt={persona.displayName}
      className="h-7 w-7 rounded-full object-cover"
      fallback={fallback}
    />
  );
}
