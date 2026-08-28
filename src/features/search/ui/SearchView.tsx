import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { useShallow } from "zustand/react/shallow";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";
import type { ExtensionEntry } from "@/features/extensions/types";
import type { SkillInfo } from "@/features/skills/api/skills";
import {
  getVisibleSettingsSections,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import { telemetryConsentEnforced } from "@/shared/telemetry/consent";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectLocalMessageCountsBySession } from "@/features/chat/stores/chatSelectors";
import {
  type ChatSession,
  getVisibleSessions,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useSessionSearch } from "@/features/sessions/hooks/useSessionSearch";
import type { SessionSearchDisplayResult } from "@/features/sessions/lib/buildSessionSearchResults";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { useLocaleFormatting } from "@/shared/i18n";
import { sessionSearchStamp } from "@/shared/api/sessionSearch";
import {
  extensionSearchIdentity,
  useExtensionSearch,
} from "../hooks/useExtensionSearch";
import { useAgentSearch } from "../hooks/useAgentSearch";
import { useAutomationSearch } from "../hooks/useAutomationSearch";
import { useSkillSearch } from "../hooks/useSkillSearch";
import {
  buildResultNavigationModel,
  buildSettingsSearchResults,
  findResultPosition,
  type SearchCategory,
  searchResultId,
} from "../lib/searchResultModel";
import { AgentResultRow } from "./AgentResultRow";
import { AutomationResultRow } from "./AutomationResultRow";
import { ChatResultRow } from "./ChatResultRow";
import { ExtensionResultRow } from "./ExtensionResultRow";
import { SearchHeadingInput } from "./SearchHeadingInput";
import {
  SearchResultsCard,
  type SearchResultsCardTone,
} from "./SearchResultsCard";
import { SkillResultRow } from "./SkillResultRow";
import { SettingsResultRow } from "./SettingsResultRow";

interface SearchViewProps {
  variant?: "page" | "dialog";
  onExit: () => void;
  onSelectSearchResult: (
    sessionId: string,
    messageId?: string,
    query?: string,
    /** The result row's own session, passed so the caller can hydrate
     *  server-discovered sessions into the store before activating them. */
    session?: ChatSession,
  ) => void;
  onOpenExtension: (entry: ExtensionEntry) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenSkill: (skill: SkillInfo) => void;
  onOpenSettings?: (sectionId: SectionId) => void;
  escapeRequest?: number;
}

const DEBOUNCE_MS = 100;
const searchViewStyle = {
  "--search-results-top": "100px",
  "--search-results-height": "min(620px, calc(100% - 132px))",
} as CSSProperties;

export function SearchView({
  variant = "page",
  onExit,
  onSelectSearchResult,
  onOpenExtension,
  onOpenAgent,
  onOpenAutomation,
  onOpenSkill,
  onOpenSettings,
  escapeRequest = 0,
}: SearchViewProps) {
  const { t, i18n } = useTranslation([
    "search",
    "sessions",
    "common",
    "settings",
  ]);
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const capabilities = useProfileCapabilities();
  const remoteSshSessionsEnabled =
    useExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled === true;
  const visibleSettingsSections = useMemo(
    () => getVisibleSettingsSections(capabilities),
    [capabilities],
  );
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const [leftFadeAmount, setLeftFadeAmount] = useState(0);
  const [rightFadeAmount, setRightFadeAmount] = useState(0);
  const [query, setQuery] = useState("");
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SearchCategory>("all");
  const [dialogResultsEl, setDialogResultsEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [showDialogTopFade, setShowDialogTopFade] = useState(false);
  const [showDialogBottomFade, setShowDialogBottomFade] = useState(false);
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  const trimmedQuery = query.trim();
  const trimmedDebouncedQuery = debouncedQuery.trim();

  const sessions = useChatSessionStore((state) => state.sessions);
  const localMessageCountsBySession = useChatStore(
    useShallow(selectLocalMessageCountsBySession),
  );
  const personas = useAgentStore((state) => state.personas);
  const projects = useProjectStore((state) => state.projects);

  const visibleSessions = useMemo(
    () =>
      getVisibleSessions(
        sessions.filter((session) => !session.archivedAt),
        localMessageCountsBySession,
      ),
    [localMessageCountsBySession, sessions],
  );

  const resolvers = useMemo(
    () => ({
      getPersonaName: (personaId: string) =>
        personas.find((persona) => persona.id === personaId)?.displayName,
      getProjectName: (projectId: string) =>
        projects.find((project) => project.id === projectId)?.name,
    }),
    [personas, projects],
  );

  const defaultTitle = t("common:session.defaultTitle");
  const getDisplayTitle = useCallback(
    (session: ChatSession) =>
      getDisplaySessionTitle(session.title, defaultTitle),
    [defaultTitle],
  );
  const chatSearch = useSessionSearch({
    sessions: visibleSessions,
    resolvers,
    locale: i18n.resolvedLanguage,
    getDisplayTitle,
    visibleMetadataOnly: true,
    // Cmd-K's loaded slice excludes archived sessions; server-discovered
    // matches must follow the same policy.
    includeDiscoveredSession: (session) => !session.archivedAt,
  });
  const {
    clear: clearChatSearch,
    isSearching: isChatSearching,
    results: chatResults,
    search: runChatSearch,
    setQuery: setChatQuery,
    submittedQuery,
  } = chatSearch;
  const extensionResults = useExtensionSearch(debouncedQuery);
  const agentResults = useAgentSearch(debouncedQuery);
  const automationResults = useAutomationSearch(debouncedQuery);
  const skillResults = useSkillSearch(debouncedQuery);
  const settingsResults = useMemo(
    () =>
      buildSettingsSearchResults({
        query: trimmedDebouncedQuery,
        enabled: Boolean(onOpenSettings),
        translate: (key) => t(`settings:${key}`),
        visibleSections: visibleSettingsSections,
        // Hidden entries mirror rows their pages do not render: chat tips
        // without agent tools, and the telemetry toggle both in enforced
        // builds and without the `telemetry` capability, which is what
        // TelemetryConsentRow itself hides on
        // (telemetryConsentEnforced() is a build constant, so it needs no
        // memo dependency; the capability is reactive and does).
        hiddenItemIds: [
          ...(capabilities.agentTools ? [] : ["chat-tips"]),
          ...(telemetryConsentEnforced() || !capabilities.telemetry
            ? ["telemetry"]
            : []),
          // The remote SSH hosts card only renders on the connections page
          // while its experiment is on (RemoteHostsSettings returns null).
          ...(remoteSshSessionsEnabled ? [] : ["remote-ssh-hosts"]),
        ],
      }),
    [
      capabilities.agentTools,
      capabilities.telemetry,
      onOpenSettings,
      remoteSshSessionsEnabled,
      t,
      trimmedDebouncedQuery,
      visibleSettingsSections,
    ],
  );

  // Sweeps are keyed on who is in the list and what version of them we hold,
  // not on session object identity: store churn (title streams, unread flips,
  // `activeRunId` notifications, the persona/project refresh) must not re-fire
  // a full export sweep, while sessions arriving after mount (initial load,
  // background pagination) and content changes in sessions already on screen
  // still get swept.
  //
  // The keys are sorted because list order is not membership: every
  // `loadSessions()` merge re-sorts by activity, so a background session
  // receiving a message reshuffles the list without changing who is in it.
  // Sorting `id:stamp` is equivalent to sorting by id, since ids are unique.
  //
  // Stamps are safe triggers: nothing on the frontend patches them per token or
  // per message. `session_info_update` for meta changes leaves them alone, so
  // they only move on the 60s/window-focus list refresh (all changed sessions
  // batch into one store update, hence one sweep) and on the once-per-run name
  // generation notification. Each such sweep re-exports only the sessions whose
  // stamp actually moved — the rest are corpus-cache hits — and the hook treats
  // a re-sent query as additive, so rendered rows stay put until it resolves.
  const sessionSweepKey = useMemo(
    () =>
      visibleSessions
        .map((session) => `${session.id}:${sessionSearchStamp(session)}`)
        .sort()
        .join("\n"),
    [visibleSessions],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionSweepKey is an intentional trigger; runChatSearch reads the sessions through a ref.
  useEffect(() => {
    setChatQuery(debouncedQuery);
    void runChatSearch(debouncedQuery);
  }, [debouncedQuery, sessionSweepKey, runChatSearch, setChatQuery]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const updateFades = useCallback(() => {
    if (!railEl) return;
    const maxScroll = railEl.scrollWidth - railEl.clientWidth;
    if (maxScroll <= 0) {
      setLeftFadeAmount(0);
      setRightFadeAmount(0);
      return;
    }
    const threshold = Math.min(120, maxScroll);
    const distanceFromStart = railEl.scrollLeft;
    const distanceToEnd = maxScroll - railEl.scrollLeft;
    setLeftFadeAmount(Math.max(0, Math.min(1, distanceFromStart / threshold)));
    setRightFadeAmount(Math.max(0, Math.min(1, distanceToEnd / threshold)));
  }, [railEl]);

  useEffect(() => {
    if (!railEl) return;
    railEl.addEventListener("scroll", updateFades, { passive: true });
    const ro = new ResizeObserver(updateFades);
    ro.observe(railEl);
    return () => {
      railEl.removeEventListener("scroll", updateFades);
      ro.disconnect();
    };
  }, [railEl, updateFades]);

  useEffect(() => {
    if (!dialogResultsEl) return;
    const updateDialogFades = () => {
      const remaining =
        dialogResultsEl.scrollHeight -
        dialogResultsEl.clientHeight -
        dialogResultsEl.scrollTop;
      setShowDialogTopFade(dialogResultsEl.scrollTop > 8);
      setShowDialogBottomFade(remaining > 8);
    };
    updateDialogFades();
    dialogResultsEl.addEventListener("scroll", updateDialogFades, {
      passive: true,
    });
    const observer = new ResizeObserver(updateDialogFades);
    observer.observe(dialogResultsEl);
    return () => {
      dialogResultsEl.removeEventListener("scroll", updateDialogFades);
      observer.disconnect();
    };
  }, [dialogResultsEl]);

  // Recompute fades when the rendered result counts change. The listener
  // effect above catches scroll + container resize; this dep list catches
  // the case where the same rail stays mounted but the cards inside it
  // change (different query → different scrollWidth).
  // biome-ignore lint/correctness/useExhaustiveDependencies: result-length deps are intentional triggers, not values read inside.
  useEffect(() => {
    updateFades();
  }, [
    updateFades,
    chatResults.length,
    extensionResults.length,
    agentResults.length,
    skillResults.length,
    automationResults.length,
  ]);

  const recentChatResults = useMemo<SessionSearchDisplayResult[]>(
    () =>
      [...visibleSessions]
        .sort(compareSessionsByActivityDesc)
        .slice(0, 15)
        .map((session) => ({ session, matchType: "metadata" as const })),
    [visibleSessions],
  );
  const displayedChatResults = trimmedDebouncedQuery.length
    ? chatResults
    : recentChatResults;

  const hasAnyResults =
    displayedChatResults.length > 0 ||
    extensionResults.length > 0 ||
    agentResults.length > 0 ||
    automationResults.length > 0 ||
    skillResults.length > 0 ||
    settingsResults.length > 0;
  const showResults = hasAnyResults;
  const showNoMatches =
    trimmedDebouncedQuery.length > 0 && !hasAnyResults && !isChatSearching;

  const resultColumnsByCategory = useMemo<Record<SearchCategory, string[]>>(
    () => ({
      all: [],
      chat: displayedChatResults.map((result) =>
        searchResultId(
          "chat",
          `${result.session.id}:${result.messageId ?? "session"}`,
        ),
      ),
      extensions: extensionResults.map(({ entry }) =>
        searchResultId("extension", extensionSearchIdentity(entry)),
      ),
      agents: agentResults.map((agent) => searchResultId("agent", agent.id)),
      skills: skillResults.map((skill) => searchResultId("skill", skill.name)),
      automations: automationResults.flatMap((automation) =>
        automation.id ? [searchResultId("automation", automation.id)] : [],
      ),
      settings: settingsResults.map((section) =>
        searchResultId("settings", section.id),
      ),
    }),
    [
      agentResults,
      automationResults,
      displayedChatResults,
      extensionResults,
      settingsResults,
      skillResults,
    ],
  );
  const {
    allIds: allResultIds,
    navigableColumns: navigableResultColumns,
    navigableIds: navigableResultIds,
  } = useMemo(
    () =>
      buildResultNavigationModel({
        activeCategory,
        columnsByCategory: resultColumnsByCategory,
      }),
    [activeCategory, resultColumnsByCategory],
  );

  useEffect(() => {
    if (!showResults) {
      setActiveResultId(null);
      return;
    }

    setActiveResultId((current) =>
      current && navigableResultIds.includes(current) ? current : null,
    );
  }, [navigableResultIds, showResults]);

  useEffect(() => {
    if (!activeResultId) {
      return;
    }

    const element = document.getElementById(activeResultId);
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeResultId]);

  const handleEscape = useCallback(() => {
    if (query.trim()) {
      setQuery("");
      clearChatSearch();
      inputRef.current?.focus();
    } else {
      onExit();
    }
  }, [clearChatSearch, onExit, query]);

  const handledEscapeRequestRef = useRef(escapeRequest);
  useEffect(() => {
    if (handledEscapeRequestRef.current === escapeRequest) return;
    handledEscapeRequestRef.current = escapeRequest;
    handleEscape();
  }, [escapeRequest, handleEscape]);

  const handleEscapeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      handleEscape();
    },
    [handleEscape],
  );

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        showResults &&
        navigableResultIds.length > 0
      ) {
        event.preventDefault();
        setActiveResultId((current) => {
          const currentIndex = current
            ? navigableResultIds.indexOf(current)
            : -1;
          if (event.key === "ArrowDown") {
            return (
              navigableResultIds[
                (currentIndex + 1) % navigableResultIds.length
              ] ?? null
            );
          }
          const previousIndex =
            currentIndex <= 0
              ? navigableResultIds.length - 1
              : currentIndex - 1;
          return navigableResultIds[previousIndex] ?? null;
        });
        return;
      }

      if (
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        showResults &&
        navigableResultColumns.length > 0
      ) {
        event.preventDefault();
        setActiveResultId((current) => {
          const position = findResultPosition(navigableResultColumns, current);
          const direction = event.key === "ArrowRight" ? 1 : -1;

          if (!position) {
            const column =
              direction > 0
                ? navigableResultColumns[0]
                : navigableResultColumns[navigableResultColumns.length - 1];
            return column?.[0] ?? null;
          }

          const columnIndex =
            (position.columnIndex + direction + navigableResultColumns.length) %
            navigableResultColumns.length;
          const column = navigableResultColumns[columnIndex];
          const rowIndex = Math.min(position.rowIndex, column.length - 1);
          return column[rowIndex] ?? null;
        });
        return;
      }

      if (event.key === "Enter" && activeResultId) {
        const activeElement = document.getElementById(activeResultId);
        if (activeElement instanceof HTMLButtonElement) {
          event.preventDefault();
          activeElement.click();
        }
      }
    },
    [activeResultId, navigableResultColumns, navigableResultIds, showResults],
  );

  const resultSections: Array<{
    key: string;
    label: string;
    tone: SearchResultsCardTone;
    children: ReactNode[];
  }> = [];

  if (displayedChatResults.length > 0) {
    resultSections.push({
      key: "chat",
      label: trimmedDebouncedQuery.length
        ? t("sections.chat")
        : t("sections.recents"),
      tone: "file",
      children: displayedChatResults.map((result) => {
        const title = getDisplaySessionTitle(
          result.session.title,
          defaultTitle,
        );
        const resultId = searchResultId(
          "chat",
          `${result.session.id}:${result.messageId ?? "session"}`,
        );
        return (
          <ChatResultRow
            id={resultId}
            key={result.session.id}
            result={result}
            defaultTitle={defaultTitle}
            ariaLabel={t("actions.openSession", { name: title })}
            query={trimmedQuery}
            project={
              result.session.projectId
                ? projects.find(
                    (project) => project.id === result.session.projectId,
                  )
                : undefined
            }
            formatRelativeTimeToNow={formatRelativeTimeToNow}
            isActive={activeResultId === resultId}
            onActive={() => setActiveResultId(resultId)}
            onSelect={(sessionId, messageId) =>
              onSelectSearchResult(
                sessionId,
                messageId,
                submittedQuery || trimmedDebouncedQuery,
                result.session,
              )
            }
          />
        );
      }),
    });
  }

  if (extensionResults.length > 0) {
    resultSections.push({
      key: "extensions",
      label: t("sections.extensions"),
      tone: "automation",
      children: extensionResults.map(({ entry, state }) => {
        const extensionIdentity = extensionSearchIdentity(entry);
        const resultId = searchResultId("extension", extensionIdentity);
        return (
          <ExtensionResultRow
            id={resultId}
            key={extensionIdentity}
            entry={entry}
            stateLabel={t(`states.${state}`)}
            ariaLabel={t("actions.openExtension", { name: entry.name })}
            query={trimmedQuery}
            isActive={activeResultId === resultId}
            onActive={() => setActiveResultId(resultId)}
            onSelect={onOpenExtension}
          />
        );
      }),
    });
  }

  if (agentResults.length > 0) {
    resultSections.push({
      key: "agents",
      label: t("sections.agents"),
      tone: "agent",
      children: agentResults.map((agent) => (
        <AgentResultRow
          id={searchResultId("agent", agent.id)}
          key={agent.id}
          agent={agent}
          ariaLabel={t("actions.openAgent", {
            name: agent.displayName,
          })}
          query={trimmedQuery}
          isActive={activeResultId === searchResultId("agent", agent.id)}
          onActive={() => setActiveResultId(searchResultId("agent", agent.id))}
          onSelect={onOpenAgent}
        />
      )),
    });
  }

  if (skillResults.length > 0) {
    resultSections.push({
      key: "skills",
      label: t("sections.skills"),
      tone: "skill",
      children: skillResults.map((skill) => (
        <SkillResultRow
          id={searchResultId("skill", skill.name)}
          key={skill.name}
          skill={skill}
          ariaLabel={t("actions.openSkill", { name: skill.name })}
          query={trimmedQuery}
          isActive={activeResultId === searchResultId("skill", skill.name)}
          onActive={() =>
            setActiveResultId(searchResultId("skill", skill.name))
          }
          onSelect={onOpenSkill}
        />
      )),
    });
  }

  if (automationResults.length > 0) {
    const automationFallback = t("fallbackTitles.automation");
    resultSections.push({
      key: "automations",
      label: t("sections.automations"),
      tone: "automation",
      children: automationResults.map((automation) => {
        const displayName = automation.title?.trim() || automationFallback;
        const resultId = automation.id
          ? searchResultId("automation", automation.id)
          : undefined;
        return (
          <AutomationResultRow
            id={resultId}
            key={automation.id ?? displayName}
            automation={automation}
            fallbackTitle={automationFallback}
            ariaLabel={t("actions.openAutomation", { name: displayName })}
            query={trimmedQuery}
            isActive={activeResultId === resultId}
            onActive={resultId ? () => setActiveResultId(resultId) : undefined}
            onSelect={onOpenAutomation}
          />
        );
      }),
    });
  }

  if (settingsResults.length > 0 && onOpenSettings) {
    resultSections.push({
      key: "settings",
      label: t("sections.settings"),
      tone: "automation",
      children: settingsResults.map((item) => {
        const resultId = searchResultId("settings", item.id);
        return (
          <SettingsResultRow
            id={resultId}
            key={item.id}
            sectionId={item.sectionId}
            title={item.title}
            meta={t("settingsResult.meta", { name: item.title })}
            ariaLabel={t("actions.openSettings", { name: item.title })}
            query={trimmedQuery}
            isActive={activeResultId === resultId}
            onActive={() => setActiveResultId(resultId)}
            onSelect={onOpenSettings}
          />
        );
      }),
    });
  }

  const categorySections = trimmedDebouncedQuery
    ? resultSections
    : resultSections.filter((section) => section.key === "chat");
  const visibleSections =
    activeCategory === "all"
      ? categorySections
      : categorySections.filter((section) => section.key === activeCategory);
  const visibleResultsContent = visibleSections.flatMap(
    (section) => section.children,
  );
  useEffect(() => {
    if (
      activeCategory !== "all" &&
      !categorySections.some((section) => section.key === activeCategory)
    ) {
      setActiveCategory("all");
    }
  }, [activeCategory, categorySections]);
  const recentContent = resultSections.find(
    (section) => section.key === "chat",
  )?.children;

  return (
    <section
      className={cn(
        "relative h-full w-full",
        variant === "page" && "overflow-hidden",
        variant === "dialog" &&
          "min-h-0 min-w-0 max-w-full flex flex-col overflow-visible [contain:inline-size]",
      )}
      style={variant === "page" ? searchViewStyle : undefined}
      data-search-view="true"
      onKeyDownCapture={handleEscapeKeyDown}
    >
      <div className={cn(variant === "dialog" && "relative shrink-0")}>
        {variant === "dialog" ? (
          <Search
            aria-hidden="true"
            className="absolute left-1 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        ) : null}
        <SearchHeadingInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          activeDescendant={showResults ? activeResultId : null}
          controlsId={resultsId}
          isRaised={trimmedQuery.length > 0}
          variant={variant}
          placeholder={t("heading.placeholder")}
          ariaLabel={t("heading.ariaLabel")}
          onKeyDown={handleSearchKeyDown}
        />
        {variant === "dialog" && query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("actions.clear")}
            tooltip={t("actions.clear")}
            onClick={() => {
              setQuery("");
              clearChatSearch();
              inputRef.current?.focus();
            }}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2"
          >
            <X aria-hidden="true" className="!size-4" />
          </Button>
        ) : null}
      </div>

      {variant === "dialog" && showResults ? (
        <div className="relative -mx-2 min-h-0 min-w-0 w-[calc(100%+1rem)] flex-1 overflow-hidden">
          <div
            key={trimmedQuery || "recents"}
            ref={setDialogResultsEl}
            id={resultsId}
            className="mt-4 h-[calc(100%-1rem)] min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-2 pb-10 scrollbar-visible [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1"
          >
            <div
              className={cn(
                "sticky top-0 z-20 mb-2 flex h-8 min-w-0 max-w-full items-center bg-popover after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-popover after:to-transparent after:transition-opacity after:duration-150",
                showDialogTopFade ? "after:opacity-100" : "after:opacity-0",
              )}
            >
              {trimmedDebouncedQuery.length ? (
                <Tabs
                  value={activeCategory}
                  onValueChange={(value) =>
                    setActiveCategory(value as SearchCategory)
                  }
                  className="min-w-0 max-w-full"
                >
                  <TabsList
                    variant="weight"
                    aria-label={t("heading.filterAriaLabel")}
                    className="max-w-full justify-start gap-3 overflow-x-auto font-normal scrollbar-none [&_[data-slot=tabs-trigger]]:font-normal"
                  >
                    <TabsTrigger variant="weight" value="all">
                      {t("sections.results")} ({allResultIds.length})
                    </TabsTrigger>
                    {categorySections.map((section) => (
                      <TabsTrigger
                        key={section.key}
                        variant="weight"
                        value={section.key}
                      >
                        {section.label} ({section.children.length})
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              ) : (
                <h2 className="text-sm font-normal text-muted-foreground/75">
                  {t("sections.recents")}
                </h2>
              )}
            </div>
            <div
              key={`${trimmedQuery}:${activeCategory}`}
              className="space-y-0.5"
            >
              {trimmedDebouncedQuery.length
                ? visibleResultsContent
                : recentContent}
            </div>
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-popover transition-opacity duration-150",
              showDialogBottomFade ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      ) : null}

      {variant === "page" && showResults && (
        <div
          className="absolute"
          style={{
            left: 37,
            right: 24,
            top: "var(--search-results-top)",
            height: "var(--search-results-height)",
          }}
        >
          <div
            id={resultsId}
            ref={setRailEl}
            data-testid="search-results-rail"
            className="flex h-full gap-9 overflow-x-auto pb-4 scrollbar-none"
            style={{
              maskImage: `linear-gradient(to right, transparent 0%, black ${80 * leftFadeAmount}px, black calc(100% - ${80 * rightFadeAmount}px), transparent 100%)`,
              WebkitMaskImage: `linear-gradient(to right, transparent 0%, black ${80 * leftFadeAmount}px, black calc(100% - ${80 * rightFadeAmount}px), transparent 100%)`,
            }}
          >
            {resultSections.map((section) => (
              <SearchResultsCard
                key={section.key}
                label={section.label}
                tone={section.tone}
              >
                {section.children}
              </SearchResultsCard>
            ))}
          </div>
        </div>
      )}

      {showNoMatches && (
        <p
          className={cn(
            "animate-fade-in text-center text-sm italic text-muted-foreground motion-reduce:animate-none",
            variant === "page" &&
              "absolute left-1/2 top-[520px] -translate-x-1/2",
            variant === "dialog" && "py-8",
          )}
        >
          {t("noMatches", { query: trimmedDebouncedQuery })}
        </p>
      )}
    </section>
  );
}
