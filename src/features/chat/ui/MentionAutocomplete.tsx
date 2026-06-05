import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, User } from "lucide-react";
import { IconFile, IconFolder } from "@tabler/icons-react";
import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import { cn } from "@/shared/lib/cn";
import { useAvatarImage } from "@/shared/hooks/useAvatarSrc";
import { PopoverContent } from "@/shared/ui/popover";
import type { Persona } from "@/shared/types/agents";
import type {
  FileMentionItem,
  MentionItem,
  SkillMentionItem,
} from "./mentionDetection";
export { fuzzyMatch, useMentionDetection } from "./mentionDetection";
export type {
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
  onClose?: (() => void) | undefined;
  selectedIndex?: number;
  listboxId?: string;
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
  selectedIndex: controlledIndex,
  listboxId = "mention-autocomplete-listbox",
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
    for (const f of filteredFiles) {
      result.push({ type: "file" as const, file: f });
    }
    for (const p of filteredPersonas) {
      result.push({ type: "persona" as const, persona: p });
    }
    for (const skill of filteredSkills) {
      result.push({ type: "skill" as const, skill });
    }
    return result;
  }, [filteredPersonas, filteredSkills, filteredFiles]);

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

  const hasResults = items.length > 0;
  const showEmpty = !pathsLoading && !pathsError && !hasResults;
  const getFileLabel = (file: FileMentionItem) => {
    if (file.shortcut === "home") return t("mention.homeFolder");
    if (file.shortcut === "filesystemRoot") {
      return t("mention.filesystemRoot");
    }
    return file.filename;
  };
  const getFileDescription = (file: FileMentionItem) => {
    if (file.shortcut === "projectRoot") {
      return t("mention.projectRoot");
    }
    return file.displayPath;
  };

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={4}
      className="w-72 px-1 py-1"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
    >
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {t("mention.referencesTitle")}
      </div>
      <div className="max-h-56 overflow-y-auto">
        <div role="listbox" id={listboxId} aria-label={t("mention.ariaLabel")}>
          {(filteredFiles.length > 0 || pathsLoading || pathsError) && (
            <div
              role="presentation"
              className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("mention.pathsTitle")}
            </div>
          )}
          {filteredFiles.map((file, i) => {
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
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => handleSelect({ type: "file", file })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                {file.kind !== "file" ? (
                  <IconFolder className="size-4 shrink-0" />
                ) : (
                  <IconFile className="size-4 shrink-0" />
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">
                    {getFileLabel(file)}
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {getFileDescription(file)}
                  </span>
                </div>
              </button>
            );
          })}
          {filteredPersonas.length > 0 && (
            <div
              role="presentation"
              className="mt-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("mention.title")}
            </div>
          )}
          {filteredPersonas.map((persona, i) => {
            const globalIndex = filteredFiles.length + i;
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
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => handleSelect({ type: "persona", persona })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                <MentionAvatar persona={persona} />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">
                    {persona.displayName}
                  </span>
                  {persona.provider && (
                    <span className="text-[10px] text-muted-foreground">
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

          {filteredSkills.length > 0 && (
            <div
              role="presentation"
              className="mt-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("mention.skillsTitle")}
            </div>
          )}
          {filteredSkills.map((skill, i) => {
            const globalIndex =
              filteredFiles.length + filteredPersonas.length + i;
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
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => handleSelect({ type: "skill", skill })}
                onMouseEnter={() => setInternalIndex(globalIndex)}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <SkillIcon className="h-3.5 w-3.5" />
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{skill.name}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {skill.description || skill.sourceLabel}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {pathsLoading && (
          <div
            role="status"
            aria-live="polite"
            className="px-2 py-2 text-sm text-muted-foreground"
          >
            {t("mention.loadingPaths")}
          </div>
        )}
        {pathsError && (
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
      <div className="border-t px-2 py-1.5 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">
          {t("mention.enterKey")}
        </span>{" "}
        {t("mention.toInsert")}
      </div>
    </PopoverContent>
  );
}

// ---------------------------------------------------------------------------
// Avatar helper
// ---------------------------------------------------------------------------

function MentionAvatar({ persona }: { persona: Persona }) {
  const avatarImage = useAvatarImage(persona.avatar);
  if (avatarImage) {
    return (
      <img
        src={avatarImage}
        alt={persona.displayName}
        className="h-7 w-7 rounded-full object-cover"
      />
    );
  }

  return (
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
}
