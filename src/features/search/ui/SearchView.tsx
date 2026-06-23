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
import { useShallow } from "zustand/react/shallow";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { ExtensionEntry } from "@/features/extensions/types";
import type { SkillInfo } from "@/features/skills/api/skills";
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
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { useLocaleFormatting } from "@/shared/i18n";
import { useExtensionSearch } from "../hooks/useExtensionSearch";
import { useAgentSearch } from "../hooks/useAgentSearch";
import { useAutomationSearch } from "../hooks/useAutomationSearch";
import { useSkillSearch } from "../hooks/useSkillSearch";
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

interface SearchViewProps {
  onExit: () => void;
  onSelectSearchResult: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  onOpenExtension: (entry: ExtensionEntry) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenSkill: (skill: SkillInfo) => void;
}

const DEBOUNCE_MS = 100;

const searchViewStyle = {
  "--search-results-top": "clamp(260px, 39vh, 374px)",
  "--search-heading-raised-top":
    "clamp(32px, calc(50% - 264px), calc(var(--search-results-top) - 152px))",
  "--search-results-height":
    "min(512px, max(220px, calc(100% - var(--search-results-top) - 132px)))",
} as CSSProperties;

function searchResultId(kind: string, key: string): string {
  return `search-result-${kind}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function findResultPosition(
  resultColumns: string[][],
  resultId: string | null,
): { columnIndex: number; rowIndex: number } | null {
  if (!resultId) {
    return null;
  }

  for (
    let columnIndex = 0;
    columnIndex < resultColumns.length;
    columnIndex += 1
  ) {
    const rowIndex = resultColumns[columnIndex].indexOf(resultId);
    if (rowIndex >= 0) {
      return { columnIndex, rowIndex };
    }
  }

  return null;
}

export function SearchView({
  onExit,
  onSelectSearchResult,
  onOpenExtension,
  onOpenAgent,
  onOpenAutomation,
  onOpenSkill,
}: SearchViewProps) {
  const { t, i18n } = useTranslation(["search", "sessions", "common"]);
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const [leftFadeAmount, setLeftFadeAmount] = useState(0);
  const [rightFadeAmount, setRightFadeAmount] = useState(0);
  const [query, setQuery] = useState("");
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
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

  useEffect(() => {
    setChatQuery(debouncedQuery);
    void runChatSearch(debouncedQuery);
  }, [debouncedQuery, runChatSearch, setChatQuery]);

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      if (query.trim()) {
        setQuery("");
        clearChatSearch();
        inputRef.current?.focus();
        return;
      }

      onExit();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearChatSearch, onExit, query]);

  const hasAnyResults =
    chatResults.length > 0 ||
    extensionResults.length > 0 ||
    agentResults.length > 0 ||
    automationResults.length > 0 ||
    skillResults.length > 0;
  const showResults = trimmedDebouncedQuery.length > 0 && hasAnyResults;
  const showNoMatches =
    trimmedDebouncedQuery.length > 0 && !hasAnyResults && !isChatSearching;

  const resultColumns = useMemo(
    () =>
      [
        chatResults.map((result) =>
          searchResultId(
            "chat",
            `${result.session.id}:${result.messageId ?? "session"}`,
          ),
        ),
        extensionResults.map(({ entry }) =>
          searchResultId("extension", entry.config_key),
        ),
        agentResults.map((agent) => searchResultId("agent", agent.id)),
        skillResults.map((skill) => searchResultId("skill", skill.name)),
        automationResults.flatMap((automation) =>
          automation.id ? [searchResultId("automation", automation.id)] : [],
        ),
      ].filter((column) => column.length > 0),
    [
      agentResults,
      automationResults,
      chatResults,
      extensionResults,
      skillResults,
    ],
  );
  const resultIds = useMemo(() => resultColumns.flat(), [resultColumns]);

  useEffect(() => {
    if (!showResults) {
      setActiveResultId(null);
      return;
    }

    setActiveResultId((current) =>
      current && resultIds.includes(current) ? current : null,
    );
  }, [resultIds, showResults]);

  useEffect(() => {
    if (!activeResultId) {
      return;
    }

    const element = document.getElementById(activeResultId);
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeResultId]);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        showResults &&
        resultIds.length > 0
      ) {
        event.preventDefault();
        setActiveResultId((current) => {
          const currentIndex = current ? resultIds.indexOf(current) : -1;
          if (event.key === "ArrowDown") {
            return resultIds[(currentIndex + 1) % resultIds.length] ?? null;
          }
          const previousIndex =
            currentIndex <= 0 ? resultIds.length - 1 : currentIndex - 1;
          return resultIds[previousIndex] ?? null;
        });
        return;
      }

      if (
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        showResults &&
        resultColumns.length > 0
      ) {
        event.preventDefault();
        setActiveResultId((current) => {
          const position = findResultPosition(resultColumns, current);
          const direction = event.key === "ArrowRight" ? 1 : -1;

          if (!position) {
            const column =
              direction > 0
                ? resultColumns[0]
                : resultColumns[resultColumns.length - 1];
            return column?.[0] ?? null;
          }

          const columnIndex =
            (position.columnIndex + direction + resultColumns.length) %
            resultColumns.length;
          const column = resultColumns[columnIndex];
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
    [activeResultId, resultColumns, resultIds, showResults],
  );

  const resultSections: Array<{
    key: string;
    label: string;
    tone: SearchResultsCardTone;
    children: ReactNode;
  }> = [];

  if (chatResults.length > 0) {
    resultSections.push({
      key: "chat",
      label: t("sections.chat"),
      tone: "file",
      children: chatResults.map((result) => {
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
            formatRelativeTimeToNow={formatRelativeTimeToNow}
            t={t}
            isActive={activeResultId === resultId}
            onActive={() => setActiveResultId(resultId)}
            onSelect={(sessionId, messageId) =>
              onSelectSearchResult(
                sessionId,
                messageId,
                submittedQuery || trimmedDebouncedQuery,
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
      children: extensionResults.map(({ entry, state }) => (
        <ExtensionResultRow
          id={searchResultId("extension", entry.config_key)}
          key={entry.config_key}
          entry={entry}
          stateLabel={t(`states.${state}`)}
          ariaLabel={t("actions.openExtension", { name: entry.name })}
          isActive={
            activeResultId === searchResultId("extension", entry.config_key)
          }
          onActive={() =>
            setActiveResultId(searchResultId("extension", entry.config_key))
          }
          onSelect={onOpenExtension}
        />
      )),
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
            isActive={activeResultId === resultId}
            onActive={resultId ? () => setActiveResultId(resultId) : undefined}
            onSelect={onOpenAutomation}
          />
        );
      }),
    });
  }

  return (
    <section
      className="relative h-full w-full overflow-hidden"
      style={searchViewStyle}
    >
      <SearchHeadingInput
        ref={inputRef}
        value={query}
        onChange={setQuery}
        activeDescendant={showResults ? activeResultId : null}
        controlsId={resultsId}
        isRaised={trimmedQuery.length > 0}
        placeholder={t("heading.placeholder")}
        ariaLabel={t("heading.ariaLabel")}
        onKeyDown={handleSearchKeyDown}
      />

      {showResults && (
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
        <p className="absolute left-1/2 top-[520px] -translate-x-1/2 animate-fade-in text-center text-[14px] italic text-muted-foreground motion-reduce:animate-none">
          {t("noMatches", { query: trimmedDebouncedQuery })}
        </p>
      )}
    </section>
  );
}
