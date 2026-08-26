import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search } from "lucide-react";
import {
  getVisibleSessions,
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectLocalMessageCountsBySession } from "@/features/chat/stores/chatSelectors";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATION_TILES_QUERY_KEY,
  AUTOMATION_TILES_STALE_TIME_MS,
  fetchAutomationTilesList,
} from "@/features/automations/api/automationTilesQuery";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { PROMPT_PINS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { SkillInfo } from "@/features/skills/api/skills";
import { areSkillPinIdsEquivalent } from "@/features/home/lib/skillPinIdentity";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import type { Persona } from "@/shared/types/agents";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";
import { HOME_WIDGET_CATEGORIES } from "../widgets/catalog";
import {
  SKILL_LIST_QUERY_KEY,
  listHomeWidgetSkills,
} from "../widgets/skillQueryKey";
import type { WidgetCategory, WidgetInstance } from "../widgets/types";

/**
 * Width of the picker's stage-two card and the popover's offset from its
 * anchor. Exported so the canvas can decide which side to open on using the
 * same source-of-truth values (see `WidgetCanvas`), keeping the two stages on
 * the same side of the click near the right screen edge.
 */
export const WIDGET_PICKER_WIDTH = 280;
export const WIDGET_PICKER_SIDE_OFFSET = 10;

interface WidgetPickerProps {
  open: boolean;
  x: number;
  y: number;
  /**
   * Which side of the anchor to open on. Decided up front by the canvas based
   * on room for the widest stage, so both picker stages stay on the same side
   * of the click instead of flipping across it near the right screen edge.
   */
  side?: "left" | "right";
  /** Moves focus into stage one when opened from a keyboard-driven action. */
  focusOnOpen?: boolean;
  instances: WidgetInstance[];
  starterTasksAvailable?: boolean;
  onClose: () => void;
  onSelect: (type: string, state?: Record<string, unknown>) => void;
  onRestoreStarterTasks: () => void;
}

type EntityCategory = "agent" | "chat" | "automation" | "project" | "skill";
type EntityStateKey =
  | "agentId"
  | "sessionId"
  | "automationId"
  | "projectId"
  | "skillId";

interface PickerOption {
  id: string;
  title: string;
  searchText?: string;
  pinned: boolean;
  /** Per-row rendering hint so the panel can show an icon / colored pill */
  leading?:
    | {
        kind: "projectIcon";
        icon: string | null | undefined;
        color: string | null | undefined;
      }
    | { kind: "skillPill"; name: string; color: string | null }
    | null;
}

// Order matches the Figma pin menu. "clock" sits under a trailing "Widgets"
// group so the entity categories (which the user is searching for) lead, and
// generative widgets sit at the end where the menu has room to grow.
const STAGE_ONE_ORDER: WidgetCategory[] = [
  "project",
  "skill",
  "agent",
  "chat",
  "automation",
  "clock",
];

const PIN_CONFIG = {
  agent: { stateKey: "agentId", widgetType: "agentPin" },
  chat: { stateKey: "sessionId", widgetType: "chatPin" },
  project: { stateKey: "projectId", widgetType: "projectArtifactPin" },
  automation: {
    stateKey: "automationId",
    widgetType: "automationOutputPin",
  },
  skill: { stateKey: "skillId", widgetType: "skillPin" },
} as const satisfies Record<
  EntityCategory,
  { stateKey: EntityStateKey; widgetType: string }
>;

function isEntityCategory(
  category: WidgetCategory,
): category is EntityCategory {
  return (
    category === "agent" ||
    category === "chat" ||
    category === "automation" ||
    category === "project" ||
    category === "skill"
  );
}

function stateString(
  instance: WidgetInstance,
  stateKey: EntityStateKey,
): string | null {
  const value = instance.state?.[stateKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getPinnedIds(
  instances: WidgetInstance[],
  category: EntityCategory,
): Set<string> {
  const { stateKey, widgetType } = PIN_CONFIG[category];

  return new Set(
    instances
      .filter((instance) => instance.type === widgetType)
      .map((instance) => stateString(instance, stateKey))
      .filter((id): id is string => Boolean(id)),
  );
}

function matchesQuery(option: PickerOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return `${option.title} ${option.searchText ?? ""}`
    .toLowerCase()
    .includes(normalized);
}

function sortAgents(personas: Persona[]): Persona[] {
  return [...personas].sort(
    (left, right) =>
      Number(right.isBuiltin) - Number(left.isBuiltin) ||
      left.displayName.localeCompare(right.displayName),
  );
}

function agentOptions(
  personas: Persona[],
  pinnedIds: Set<string>,
): PickerOption[] {
  return sortAgents(personas).map((persona) => ({
    id: persona.id,
    title: persona.displayName,
    pinned: pinnedIds.has(persona.id),
  }));
}

function chatOptions(
  sessions: ChatSession[],
  pinnedIds: Set<string>,
  projects: ProjectInfo[],
  personas: Persona[],
): PickerOption[] {
  const projectNamesById = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const personaNamesById = new Map(
    personas.map((persona) => [persona.id, persona.displayName]),
  );

  return sessions.map((session) => ({
    id: session.id,
    title: session.title.trim() || DEFAULT_CHAT_TITLE,
    searchText: [
      session.projectId ? projectNamesById.get(session.projectId) : undefined,
      session.personaId ? personaNamesById.get(session.personaId) : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    pinned: pinnedIds.has(session.id),
  }));
}

function automationOptions(
  automations: AutomationTile[],
  pinnedIds: Set<string>,
  fallbackTitle: string,
): PickerOption[] {
  return automations.flatMap((automation) =>
    automation.id
      ? [
          {
            id: automation.id,
            title: automation.title?.trim() || fallbackTitle,
            pinned: pinnedIds.has(automation.id),
          },
        ]
      : [],
  );
}

function projectOptions(
  projects: ProjectInfo[],
  pinnedIds: Set<string>,
): PickerOption[] {
  return [...projects]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      id: project.id,
      title: project.name,
      searchText: [
        project.prompt,
        project.description,
        Array.isArray(project.workingDirs) ? project.workingDirs.join(" ") : "",
      ]
        .filter(Boolean)
        .join(" "),
      pinned: pinnedIds.has(project.id),
      leading: {
        kind: "projectIcon",
        icon: project.icon,
        color: project.color,
      },
    }));
}

function skillOptions(
  skills: SkillInfo[],
  pinnedIds: Set<string>,
): PickerOption[] {
  return [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({
      id: skill.id,
      title: skill.name,
      pinned: [...pinnedIds].some((pinnedId) =>
        areSkillPinIdsEquivalent(pinnedId, skill.id, skill.legacyPinIds),
      ),
      leading: { kind: "skillPill", name: skill.name, color: skill.color },
    }));
}

interface UseWidgetPickerOptionsParams {
  activePanel: WidgetCategory | null;
  automations: AutomationTile[];
  automationFallbackTitle: string;
  instances: WidgetInstance[];
  query: string;
  skills: SkillInfo[];
}

function useWidgetPickerOptions({
  activePanel,
  automations,
  automationFallbackTitle,
  instances,
  query,
  skills,
}: UseWidgetPickerOptionsParams): PickerOption[] {
  const personas = useAgentStore((state) => state.personas);
  const projects = useProjectStore(selectProjects);
  const sessions = useChatSessionStore((state) => state.sessions);
  const localMessageCountsBySession = useChatStore(
    useShallow(selectLocalMessageCountsBySession),
  );

  const visibleSessions = useMemo(
    () =>
      getVisibleSessions(sessions, localMessageCountsBySession).filter(
        (session) => !session.archivedAt,
      ),
    [localMessageCountsBySession, sessions],
  );

  return useMemo(() => {
    if (!activePanel || !isEntityCategory(activePanel)) {
      return [];
    }

    const pinnedIds = getPinnedIds(instances, activePanel);
    let nextOptions: PickerOption[];

    switch (activePanel) {
      case "agent":
        nextOptions = agentOptions(personas, pinnedIds);
        break;
      case "chat":
        nextOptions = chatOptions(
          visibleSessions,
          pinnedIds,
          projects,
          personas,
        );
        break;
      case "project":
        nextOptions = projectOptions(projects, pinnedIds);
        break;
      case "automation":
        nextOptions = automationOptions(
          automations,
          pinnedIds,
          automationFallbackTitle,
        );
        break;
      case "skill":
        nextOptions = skillOptions(skills, pinnedIds);
        break;
      default: {
        const exhaustive: never = activePanel;
        return exhaustive;
      }
    }

    return nextOptions.filter((option) => matchesQuery(option, query));
  }, [
    activePanel,
    automationFallbackTitle,
    automations,
    instances,
    personas,
    projects,
    query,
    skills,
    visibleSessions,
  ]);
}

export function WidgetPicker({
  open,
  x,
  y,
  side = "right",
  focusOnOpen = false,
  instances,
  starterTasksAvailable = false,
  onClose,
  onSelect,
  onRestoreStarterTasks,
}: WidgetPickerProps) {
  const { t } = useTranslation("home");
  const automationsEnabled = useProfileCapability("automations");
  const promptPinsEnabled =
    useExperiment(PROMPT_PINS_EXPERIMENT_ID)?.enabled === true;
  const visibleWidgetCategories = useMemo(
    () =>
      STAGE_ONE_ORDER.filter(
        (category) =>
          HOME_WIDGET_CATEGORIES.includes(category) &&
          (category !== "automation" || automationsEnabled),
      ),
    [automationsEnabled],
  );
  const searchInputId = useId();
  const [activePanel, setActivePanel] = useState<WidgetCategory | null>(null);
  const [query, setQuery] = useState("");
  const lastChatLoadQueryRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasMoreSessions = useChatSessionStore((state) => state.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (state) => state.isLoadingMoreSessions,
  );
  const loadMoreSessions = useChatSessionStore(
    (state) => state.loadMoreSessions,
  );

  // Skill list is gated on the skill panel being active so the network call
  // only fires when the user opens that panel. Shares the SkillPinWidget
  // cache entry via SKILL_LIST_QUERY_KEY.
  const { data: skills, isPending: skillsPending } = useQuery({
    queryKey: SKILL_LIST_QUERY_KEY,
    queryFn: listHomeWidgetSkills,
    staleTime: 60_000,
    enabled: open && activePanel === "skill",
  });

  // Automation list is gated the same way, and shares the AutomationsView /
  // pin-widget / search cache entry via AUTOMATION_TILES_QUERY_KEY so tile
  // mutations invalidate the picker too.
  const {
    data: automations,
    isPending: automationsPending,
    isError: automationLoadFailed,
  } = useQuery({
    queryKey: AUTOMATION_TILES_QUERY_KEY,
    queryFn: fetchAutomationTilesList,
    staleTime: AUTOMATION_TILES_STALE_TIME_MS,
    enabled: open && activePanel === "automation" && automationsEnabled,
  });

  const options = useWidgetPickerOptions({
    activePanel,
    automations: automations ?? [],
    instances,
    query,
    skills: skills ?? [],
    automationFallbackTitle: t("widgets.automationOutputPin.fallbackTitle"),
  });

  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) {
      setActivePanel(null);
      setQuery("");
    }
  }

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (activePanel !== "chat") {
      lastChatLoadQueryRef.current = null;
    }
    if (
      !open ||
      activePanel !== "chat" ||
      !normalizedQuery ||
      !hasMoreSessions ||
      isLoadingMoreSessions ||
      lastChatLoadQueryRef.current === normalizedQuery
    ) {
      return;
    }

    lastChatLoadQueryRef.current = normalizedQuery;
    void loadMoreSessions().catch((error: unknown) => {
      console.error("Failed to load more chat sessions", error);
    });
  }, [
    activePanel,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
    open,
    query,
  ]);

  useEffect(() => {
    if (open && activePanel && isEntityCategory(activePanel)) {
      searchInputRef.current?.focus();
    }
  }, [activePanel, open]);

  if (!open) {
    return null;
  }

  const closePanel = () => {
    setActivePanel(null);
    setQuery("");
  };

  const selectCategory = (category: WidgetCategory) => {
    setActivePanel(category);
    setQuery("");
  };

  const selectOption = (option: PickerOption) => {
    if (option.pinned) {
      return;
    }
    if (!activePanel || !isEntityCategory(activePanel)) {
      return;
    }

    const { stateKey, widgetType } = PIN_CONFIG[activePanel];
    onSelect(widgetType, { [stateKey]: option.id });
  };

  const isAutomationPanel = activePanel === "automation";
  const isSkillPanel = activePanel === "skill";
  const isAutomationLoading = isAutomationPanel && automationsPending;
  const isAutomationError = isAutomationPanel && automationLoadFailed;
  const isSkillLoading = isSkillPanel && skillsPending;
  const showEmpty =
    activePanel !== null &&
    activePanel !== "clock" &&
    !isAutomationLoading &&
    !isAutomationError &&
    !isSkillLoading &&
    options.length === 0;
  const pickerMessage =
    isAutomationLoading || isSkillLoading
      ? t("widgets.picker.loading")
      : isAutomationError
        ? t("widgets.picker.loadFailed")
        : showEmpty
          ? t(`widgets.picker.empty.${activePanel}`)
          : null;
  const searchPlaceholder =
    activePanel && isEntityCategory(activePanel)
      ? t(`widgets.picker.searchPlaceholders.${activePanel}`)
      : "";

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-0"
          style={{ left: x, top: y }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={WIDGET_PICKER_SIDE_OFFSET}
        onPointerDownOutside={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-home-widget-canvas="true"]')
          ) {
            event.preventDefault();
          }
        }}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onDoubleClickCapture={(event) => event.stopPropagation()}
        onWheelCapture={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          if (!focusOnOpen) event.preventDefault();
        }}
        // Transparent shell: stage 1 is just floating pills, stage 2 supplies
        // its own white card. The popover surface itself contributes no chrome.
        style={{
          boxShadow: "none",
          ...(activePanel ? { width: WIDGET_PICKER_WIDTH } : {}),
        }}
        className={cn(
          "border-0 bg-transparent p-0 shadow-none outline-none",
          !activePanel && "w-auto",
        )}
      >
        {activePanel ? (
          <PanelStageTwo
            activePanel={activePanel}
            searchInputId={searchInputId}
            searchInputRef={searchInputRef}
            searchPlaceholder={searchPlaceholder}
            query={query}
            onQueryChange={setQuery}
            onBack={closePanel}
            options={options}
            onSelectOption={selectOption}
            pickerMessage={pickerMessage}
            onSelectClock={() => onSelect("clock")}
            onSelectStickyNote={() => onSelect("stickyNote")}
            onSelectLabel={() => onSelect("label")}
            onSelectChecklist={() => onSelect("checklist")}
            onSelectPhoto={() => onSelect("photo")}
            onSelectPromptPin={() => onSelect("promptPin")}
            onRestoreStarterTasks={onRestoreStarterTasks}
            clockLabel={t("widgets.clock.label")}
            clockPinned={instances.some(
              (instance) => instance.type === "clock",
            )}
            stickyNoteLabel={t("widgets.stickyNote.label")}
            labelLabel={t("widgets.label.label")}
            checklistLabel={t("widgets.checklist.label")}
            photoLabel={t("widgets.photo.label")}
            promptPinLabel={t("widgets.promptPin.label")}
            promptPinAvailable={promptPinsEnabled}
            starterTasksLabel={t("widgets.stickyNote.starterTasks")}
            starterTasksAvailable={starterTasksAvailable}
            backLabel={t("widgets.picker.back")}
            title={t(`widgets.picker.selectTitles.${activePanel}`)}
            isLoadingMoreSessions={isLoadingMoreSessions}
            loadingMoreLabel={t("widgets.picker.loadingMoreChats")}
          />
        ) : (
          <PanelStageOne
            categories={visibleWidgetCategories}
            headerLabel={t("widgets.picker.header")}
            onSelectCategory={selectCategory}
            getSectionLabel={(category) =>
              t(`widgets.picker.sections.${category}`)
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface PanelStageOneProps {
  categories: WidgetCategory[];
  headerLabel: string;
  onSelectCategory: (category: WidgetCategory) => void;
  getSectionLabel: (category: WidgetCategory) => string;
}

function PanelStageOne({
  categories,
  headerLabel,
  onSelectCategory,
  getSectionLabel,
}: PanelStageOneProps) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-2 text-foreground">
        <span aria-hidden="true" className="text-base leading-none">
          {/* i18n-check-ignore: emoji glyph, not translatable copy */}📌
        </span>
        <span className="text-sm font-medium">{headerLabel}</span>
      </div>
      {categories.map((category) => (
        <button
          key={category}
          type="button"
          onClick={() => onSelectCategory(category)}
          className={cn(
            "inline-flex h-[30px] items-center rounded-full bg-popover-inverse px-3 text-sm text-popover-inverse-foreground",
            "transition-[transform,background-color,opacity] duration-200 ease-out",
            "hover:scale-[1.03] hover:bg-popover-inverse/85",
            "active:scale-[0.97] active:duration-75",
            "disabled:opacity-50",
          )}
        >
          {getSectionLabel(category)}
        </button>
      ))}
    </div>
  );
}

interface PanelStageTwoProps {
  activePanel: WidgetCategory;
  searchInputId: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  query: string;
  onQueryChange: (next: string) => void;
  onBack: () => void;
  options: PickerOption[];
  onSelectOption: (option: PickerOption) => void;
  pickerMessage: string | null;
  onSelectClock: () => void;
  onSelectStickyNote: () => void;
  onSelectLabel: () => void;
  onSelectChecklist: () => void;
  onSelectPhoto: () => void;
  onSelectPromptPin: () => void;
  onRestoreStarterTasks: () => void;
  clockLabel: string;
  clockPinned: boolean;
  stickyNoteLabel: string;
  labelLabel: string;
  checklistLabel: string;
  photoLabel: string;
  promptPinLabel: string;
  promptPinAvailable: boolean;
  starterTasksLabel: string;
  starterTasksAvailable: boolean;
  backLabel: string;
  title: string;
  isLoadingMoreSessions: boolean;
  loadingMoreLabel: string;
}

function PanelStageTwo({
  activePanel,
  searchInputId,
  searchInputRef,
  searchPlaceholder,
  query,
  onQueryChange,
  onBack,
  options,
  onSelectOption,
  pickerMessage,
  onSelectClock,
  onSelectStickyNote,
  onSelectLabel,
  onSelectChecklist,
  onSelectPhoto,
  onSelectPromptPin,
  onRestoreStarterTasks,
  clockLabel,
  clockPinned,
  stickyNoteLabel,
  labelLabel,
  checklistLabel,
  photoLabel,
  promptPinLabel,
  promptPinAvailable,
  starterTasksLabel,
  starterTasksAvailable,
  backLabel,
  title,
  isLoadingMoreSessions,
  loadingMoreLabel,
}: PanelStageTwoProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-foreground">
        <button
          type="button"
          aria-label={backLabel}
          onClick={onBack}
          className="rounded-sm p-1 text-foreground transition-opacity hover:opacity-70"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="truncate text-sm font-medium">{title}</span>
      </div>

      <div className="rounded-md bg-card p-3">
        {activePanel === "clock" ? (
          <div className="space-y-0">
            <WidgetOptionRow
              label={clockLabel}
              pinned={clockPinned}
              onSelect={onSelectClock}
            />
            <WidgetOptionRow
              label={stickyNoteLabel}
              pinned={false}
              onSelect={onSelectStickyNote}
            />
            <WidgetOptionRow
              label={labelLabel}
              pinned={false}
              onSelect={onSelectLabel}
            />
            <WidgetOptionRow
              label={checklistLabel}
              pinned={false}
              onSelect={onSelectChecklist}
            />
            <WidgetOptionRow
              label={photoLabel}
              pinned={false}
              onSelect={onSelectPhoto}
            />
            {promptPinAvailable ? (
              <WidgetOptionRow
                label={promptPinLabel}
                pinned={false}
                onSelect={onSelectPromptPin}
              />
            ) : null}
            <WidgetOptionRow
              label={starterTasksLabel}
              pinned={!starterTasksAvailable}
              onSelect={onRestoreStarterTasks}
            />
          </div>
        ) : (
          <>
            <label
              htmlFor={searchInputId}
              className="flex h-9 items-center gap-2 border-b border-border/80 px-1 text-muted-foreground"
            >
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <Input
                id={searchInputId}
                inputRef={searchInputRef}
                variant="ghost"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                className="h-auto min-w-0 flex-1 p-0 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </label>

            <div className="max-h-[260px] overflow-y-auto">
              {pickerMessage ? (
                <p className="py-3 text-sm text-muted-foreground">
                  {pickerMessage}
                </p>
              ) : null}
              {options.map((option, index) => (
                <PickerRow
                  key={option.id}
                  option={option}
                  isLast={index === options.length - 1}
                  onSelect={() => onSelectOption(option)}
                />
              ))}
              {activePanel === "chat" && isLoadingMoreSessions ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {loadingMoreLabel}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface WidgetOptionRowProps {
  label: string;
  pinned: boolean;
  onSelect: () => void;
}

function WidgetOptionRow({ label, pinned, onSelect }: WidgetOptionRowProps) {
  return (
    <button
      type="button"
      disabled={pinned}
      aria-disabled={pinned || undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border/80 py-3 text-left text-sm text-foreground transition-colors last:border-b-0 hover:text-muted-foreground",
        pinned && "cursor-not-allowed opacity-50 pointer-events-none",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

interface PickerRowProps {
  option: PickerOption;
  isLast: boolean;
  onSelect: () => void;
}

function pickerRowClass(option: PickerOption, isLast: boolean): string {
  return cn(
    "flex w-full items-center gap-2 py-3 text-left text-sm text-foreground transition-colors hover:text-muted-foreground",
    isLast ? "" : "border-b border-border/80",
    option.pinned && "cursor-not-allowed opacity-50 pointer-events-none",
  );
}

function PickerRow({ option, isLast, onSelect }: PickerRowProps) {
  // Skill rows are a single colored pill that doubles as the row label;
  // they don't share the default leading-icon + title layout.
  if (option.leading?.kind === "skillPill") {
    return (
      <button
        type="button"
        disabled={option.pinned}
        aria-disabled={option.pinned || undefined}
        onClick={onSelect}
        className={pickerRowClass(option, isLast)}
      >
        <span
          className={cn(
            "shrink-0 rounded-xs px-2 py-0.5 text-xs text-skill-pill-fg",
            skillPillToneClass(
              resolveSkillPillTone(option.leading.name, option.leading.color),
            ),
          )}
        >
          {option.title}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={option.pinned}
      aria-disabled={option.pinned || undefined}
      onClick={onSelect}
      className={pickerRowClass(option, isLast)}
    >
      {option.leading?.kind === "projectIcon" ? (
        <ProjectIcon
          icon={option.leading.icon}
          color={option.leading.color}
          className="size-5 shrink-0"
          imageClassName="size-5 shrink-0"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{option.title}</span>
    </button>
  );
}
