import { useTranslation } from "react-i18next";
import { Bot, Folder } from "lucide-react";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { SessionSearchDisplayResult } from "@/features/sessions/lib/buildSessionSearchResults";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SIDEBAR_MENU_HOVER_TRANSITION_CLASS } from "@/shared/ui/sidebar-tokens";

interface SidebarSearchResultsProps {
  results: SessionSearchDisplayResult[];
  activeSessionId?: string | null;
  onSelectResult?: (sessionId: string, messageId?: string) => void;
  getPersonaName: (personaId: string) => string | undefined;
  getProjectName: (projectId: string) => string | undefined;
}

export function SidebarSearchResults({
  results,
  activeSessionId,
  onSelectResult,
  getPersonaName,
  getProjectName,
}: SidebarSearchResultsProps) {
  const { t } = useTranslation(["sidebar", "sessions", "common"]);

  if (results.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-sidebar-border/80 px-3 py-6 text-center text-sm font-normal text-muted-foreground">
        <p className="text-sidebar-foreground/80">
          {t("sessions:history.emptyNoMatches")}
        </p>
        <p className="mt-1">{t("sessions:history.emptyNoMatchesHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {results.map((result) => {
        const session = result.session;
        const displayTitle = getDisplaySessionTitle(
          session.title,
          t("common:session.defaultTitle"),
        );
        const personaName = session.personaId
          ? getPersonaName(session.personaId)
          : undefined;
        const projectName = session.projectId
          ? getProjectName(session.projectId)
          : undefined;

        return (
          <Button
            key={session.id}
            type="button"
            variant="ghost"
            onClick={() => onSelectResult?.(session.id, result.messageId)}
            className={cn(
              "h-auto w-full items-start justify-start rounded-sm border border-transparent px-3 py-2 text-left font-normal hover:bg-sidebar-accent",
              SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
              activeSessionId === session.id &&
                "border-sidebar-border/80 bg-sidebar-accent",
            )}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-sm text-sidebar-foreground">
                {displayTitle}
              </p>

              {(personaName || projectName) && (
                <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                  {personaName && (
                    <span className="inline-flex items-center gap-1">
                      <Bot className="size-3" />
                      {personaName}
                    </span>
                  )}
                  {projectName && (
                    <span className="inline-flex items-center gap-1">
                      <Folder className="size-3" />
                      {projectName}
                    </span>
                  )}
                </div>
              )}

              {result.snippet && (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {result.snippet}
                </p>
              )}

              {typeof result.matchCount === "number" && (
                <p className="text-sm text-sidebar-foreground/80">
                  {t("sessions:search.messageMatches", {
                    count: result.matchCount,
                    displayCount: result.matchCount,
                  })}
                </p>
              )}
            </div>
          </Button>
        );
      })}
    </div>
  );
}
