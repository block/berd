import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import {
  getVisibleSessions,
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import {
  getAutomationTiles,
  type AutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { Persona } from "@/shared/types/agents";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";
import {
  HOME_WIDGET_CATALOG,
  HOME_WIDGET_CATEGORIES,
} from "../widgets/catalog";
import type { WidgetCategory, WidgetInstance } from "../widgets/types";

interface WidgetPickerProps {
  open: boolean;
  x: number;
  y: number;
  instances: WidgetInstance[];
  onClose: () => void;
  onSelect: (type: string, state?: Record<string, unknown>) => void;
}

type EntityCategory = "agent" | "chat" | "automation";
type EntityStateKey = "agentId" | "sessionId" | "automationId";

interface PickerOption {
  id: string;
  title: string;
  searchText?: string;
  pinned: boolean;
}

const DEFAULT_OPTION_LIMIT = 4;

const VISIBLE_WIDGET_CATEGORIES = HOME_WIDGET_CATEGORIES.filter((category) =>
  HOME_WIDGET_CATALOG.some(
    (entry) => entry.category === category && entry.Component,
  ),
);

const PIN_CONFIG = {
  agent: { stateKey: "agentId", widgetType: "agentPin" },
  chat: { stateKey: "sessionId", widgetType: "chatPin" },
  automation: {
    stateKey: "automationId",
    widgetType: "automationOutputPin",
  },
} as const satisfies Record<
  EntityCategory,
  { stateKey: EntityStateKey; widgetType: string }
>;

function isEntityCategory(
  category: WidgetCategory,
): category is EntityCategory {
  return (
    category === "agent" || category === "chat" || category === "automation"
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

function agentOptions(personas: Persona[], pinnedIds: Set<string>) {
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
) {
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
) {
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

interface UseWidgetPickerOptionsParams {
  activePanel: WidgetCategory | null;
  automations: AutomationTile[];
  automationFallbackTitle: string;
  instances: WidgetInstance[];
  query: string;
}

function useWidgetPickerOptions({
  activePanel,
  automations,
  automationFallbackTitle,
  instances,
  query,
}: UseWidgetPickerOptionsParams): PickerOption[] {
  const personas = useAgentStore((state) => state.personas);
  const projects = useProjectStore(selectProjects);
  const sessions = useChatSessionStore((state) => state.sessions);
  const messagesBySession = useChatStore((state) => state.messagesBySession);

  const visibleSessions = useMemo(
    () =>
      getVisibleSessions(sessions, messagesBySession).filter(
        (session) => !session.archivedAt,
      ),
    [messagesBySession, sessions],
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
      case "automation":
        nextOptions = automationOptions(
          automations,
          pinnedIds,
          automationFallbackTitle,
        );
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
    visibleSessions,
  ]);
}

export function WidgetPicker({
  open,
  x,
  y,
  instances,
  onClose,
  onSelect,
}: WidgetPickerProps) {
  const { t } = useTranslation("home");
  const searchInputId = useId();
  const [activePanel, setActivePanel] = useState<WidgetCategory | null>(null);
  const [query, setQuery] = useState("");
  const [automations, setAutomations] = useState<AutomationTile[]>([]);
  const [automationStatus, setAutomationStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const automationCacheLoadedRef = useRef(false);
  const lastChatLoadQueryRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasMoreSessions = useChatSessionStore((state) => state.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (state) => state.isLoadingMoreSessions,
  );
  const loadMoreSessions = useChatSessionStore(
    (state) => state.loadMoreSessions,
  );

  const options = useWidgetPickerOptions({
    activePanel,
    automations,
    instances,
    query,
    automationFallbackTitle: t("widgets.automationOutputPin.fallbackTitle"),
  });

  useEffect(() => {
    if (open) {
      setActivePanel(null);
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || activePanel !== "automation") {
      return;
    }
    if (automationCacheLoadedRef.current) {
      return;
    }

    let cancelled = false;
    setAutomationStatus("loading");
    void getAutomationTiles()
      .then((response) => {
        if (!cancelled) {
          setAutomations(response.tiles);
          automationCacheLoadedRef.current = true;
          setAutomationStatus("idle");
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load automations", error);
        if (!cancelled) {
          setAutomationStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePanel, open]);

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
    if (!activePanel || !isEntityCategory(activePanel)) {
      return;
    }

    const { stateKey, widgetType } = PIN_CONFIG[activePanel];
    onSelect(widgetType, { [stateKey]: option.id });
  };

  const isAutomationPanel = activePanel === "automation";
  const isAutomationLoading =
    isAutomationPanel && automationStatus === "loading";
  const isAutomationError = isAutomationPanel && automationStatus === "error";
  const showEmpty =
    activePanel !== null &&
    activePanel !== "clock" &&
    !isAutomationLoading &&
    !isAutomationError &&
    options.length === 0;
  const pickerMessage = isAutomationLoading
    ? t("widgets.picker.loading")
    : isAutomationError
      ? t("widgets.picker.loadFailed")
      : showEmpty
        ? t(`widgets.picker.empty.${activePanel}`)
        : null;
  const visibleOptions = query.trim()
    ? options
    : options.slice(0, DEFAULT_OPTION_LIMIT);
  const hiddenOptionCount = options.length - visibleOptions.length;
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
        side="right"
        sideOffset={10}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onDoubleClickCapture={(event) => event.stopPropagation()}
        onWheelCapture={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className={cn(
          "overflow-hidden rounded-chrome border border-border/80 bg-sidebar p-1.5 text-foreground backdrop-blur-md",
          activePanel ? "w-72" : "w-36",
        )}
      >
        {activePanel ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={t("widgets.picker.back")}
                onClick={closePanel}
                className="rounded-tile p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </button>
              <span className="truncate px-1 text-sm font-medium">
                {t(`widgets.picker.selectTitles.${activePanel}`)}
              </span>
            </div>

            {isEntityCategory(activePanel) ? (
              <label
                htmlFor={searchInputId}
                className="flex h-8 items-center gap-2 rounded-tile border border-border/80 bg-background px-2 text-muted-foreground transition-colors focus-within:border-ring"
              >
                <Search className="size-3.5 shrink-0" aria-hidden="true" />
                <Input
                  id={searchInputId}
                  inputRef={searchInputRef}
                  variant="ghost"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  className="h-auto min-w-0 flex-1 p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </label>
            ) : null}

            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {activePanel === "clock" ? (
                <button
                  type="button"
                  onClick={() => onSelect("clock")}
                  className="flex w-full items-start justify-between gap-3 rounded-tile bg-muted px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">
                      {t("widgets.clock.label")}
                    </span>
                  </span>
                </button>
              ) : null}
              {pickerMessage ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {pickerMessage}
                </p>
              ) : null}
              {visibleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={option.pinned}
                  onClick={() => selectOption(option)}
                  className={cn(
                    "flex w-full items-start justify-between gap-3 rounded-tile px-3 py-2.5 text-left transition-colors",
                    option.pinned
                      ? "cursor-not-allowed text-muted-foreground opacity-60"
                      : "bg-muted hover:bg-muted/50",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">
                      {option.title}
                    </span>
                  </span>
                  {option.pinned ? (
                    <span className="shrink-0 rounded-pill bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t("widgets.picker.pinned")}
                    </span>
                  ) : null}
                </button>
              ))}
              {hiddenOptionCount > 0 ? (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {t("widgets.picker.searchMore")}
                </p>
              ) : null}
              {activePanel === "chat" && isLoadingMoreSessions ? (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {t("widgets.picker.loadingMoreChats")}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {VISIBLE_WIDGET_CATEGORIES.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => selectCategory(category)}
                className="flex w-full items-center justify-between rounded-tile px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
              >
                <span>{t(`widgets.picker.sections.${category}`)}</span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
