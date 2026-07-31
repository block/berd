import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconExternalLink,
  IconGitPullRequest,
  IconLoader2,
} from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import {
  advanceRelatedPullRequestScan,
  type DetectedPullRequest,
  EMPTY_RELATED_PULL_REQUEST_SCAN,
} from "../../lib/pullRequests";
import { useChatStore } from "../../stores/chatStore";
import type { Message } from "@/shared/types/messages";
import {
  getPullRequestSummaries,
  type PullRequestChecksStatus,
  type PullRequestState,
} from "@/shared/api/pullRequests";
import { cn } from "@/shared/lib/cn";
import { Widget } from "./Widget";

interface PullRequestsWidgetProps {
  pullRequests: DetectedPullRequest[];
  workspacePath?: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
}

interface SessionPullRequestsWidgetProps
  extends Omit<PullRequestsWidgetProps, "pullRequests"> {
  sessionId: string;
}

const EMPTY_MESSAGES: Message[] = [];

const STATE_DOT_CLASS: Record<PullRequestState, string> = {
  OPEN: "bg-success",
  MERGED: "bg-primary",
  CLOSED: "bg-destructive",
};

const CHECKS_DOT_CLASS: Record<PullRequestChecksStatus, string> = {
  SUCCESS: "bg-success",
  PENDING: "bg-warning",
  FAILURE: "bg-destructive",
};

export function SessionPullRequestsWidget({
  sessionId,
  ...props
}: SessionPullRequestsWidgetProps) {
  const messages = useChatStore(
    (state) => state.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const streamingMessageId = useChatStore(
    (state) => state.sessionStateById[sessionId]?.streamingMessageId ?? null,
  );
  const isLoading = useChatStore((state) =>
    state.loadingSessionIds.has(sessionId),
  );
  const [sessionScan, setSessionScan] = useState(() => ({
    sessionId,
    scan: EMPTY_RELATED_PULL_REQUEST_SCAN,
  }));

  useEffect(() => {
    setSessionScan((current) => {
      const scan = advanceRelatedPullRequestScan(
        current.sessionId === sessionId
          ? current.scan
          : EMPTY_RELATED_PULL_REQUEST_SCAN,
        messages,
        streamingMessageId,
        isLoading,
      );
      if (current.sessionId === sessionId && scan === current.scan) {
        return current;
      }
      return { sessionId, scan };
    });
  }, [isLoading, messages, sessionId, streamingMessageId]);

  const pullRequests =
    !isLoading && sessionScan.sessionId === sessionId
      ? sessionScan.scan.pullRequests
      : EMPTY_RELATED_PULL_REQUEST_SCAN.pullRequests;

  return <PullRequestsWidget pullRequests={pullRequests} {...props} />;
}

export function PullRequestsWidget({
  pullRequests,
  workspacePath,
  isOpen,
  onToggleOpen,
}: PullRequestsWidgetProps) {
  const { t } = useTranslation("chat");
  const urls = useMemo(
    () => pullRequests.map((pullRequest) => pullRequest.url),
    [pullRequests],
  );
  const { data: summaries = [], isFetching } = useQuery({
    queryKey: ["pull-request-summaries", workspacePath ?? null, urls],
    queryFn: () => getPullRequestSummaries(urls, workspacePath),
    enabled: urls.length > 0,
    retry: false,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: "always",
  });
  const summaryByUrl = useMemo(
    () => new Map(summaries.map((summary) => [summary.url, summary])),
    [summaries],
  );

  if (pullRequests.length === 0) return null;

  return (
    <Widget
      title={t("contextPanel.widgets.pullRequests")}
      icon={<IconGitPullRequest className="size-3.5" />}
      isOpen={isOpen}
      onToggleOpen={onToggleOpen}
      action={
        <span className="flex items-center gap-1.5 text-xxs text-muted-foreground">
          {isFetching ? (
            <IconLoader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : null}
          {pullRequests.length}
        </span>
      }
      flush
    >
      <div className="space-y-1 px-3">
        {pullRequests.map((pullRequest) => {
          const summary = summaryByUrl.get(pullRequest.url);
          const state = summary?.state ?? null;
          const checksStatus = summary?.checksStatus ?? null;
          const title =
            summary?.title ??
            t("contextPanel.pullRequests.fallbackTitle", {
              number: pullRequest.number,
            });

          return (
            <button
              key={pullRequest.url}
              type="button"
              className="group w-full rounded-lg border border-border/70 bg-background/45 px-3 py-2.5 text-left transition-colors hover:bg-background/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t("contextPanel.pullRequests.open", {
                repo: pullRequest.repoSlug,
                number: pullRequest.number,
              })}
              onClick={() => void openUrl(pullRequest.url)}
            >
              <div className="flex items-start gap-2">
                <IconGitPullRequest className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xxs font-medium text-muted-foreground">
                    {pullRequest.repoSlug} #{pullRequest.number}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-sm font-medium leading-4 text-foreground">
                    {title}
                  </div>
                  {state || checksStatus ? (
                    <div className="mt-2 flex min-w-0 items-center gap-2.5 text-xxs text-muted-foreground">
                      {state ? (
                        <span className="flex items-center gap-1">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              STATE_DOT_CLASS[state],
                            )}
                          />
                          {summary?.isDraft
                            ? t("contextPanel.pullRequests.state.DRAFT")
                            : t(`contextPanel.pullRequests.state.${state}`)}
                        </span>
                      ) : null}
                      {checksStatus ? (
                        <span className="flex items-center gap-1">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              CHECKS_DOT_CLASS[checksStatus],
                            )}
                          />
                          {t(
                            `contextPanel.pullRequests.checks.${checksStatus}`,
                          )}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <IconExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
          );
        })}
      </div>
    </Widget>
  );
}
