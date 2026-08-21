import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconGitPullRequest, IconLoader2 } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import {
  PullRequestListItem,
  type PullRequestListItemStatus,
} from "@/features/pull-requests/ui/PullRequestListItem";
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

const STATE_TONE: Record<PullRequestState, PullRequestListItemStatus["tone"]> =
  {
    OPEN: "success",
    MERGED: "primary",
    CLOSED: "danger",
  };

const CHECKS_TONE: Record<
  PullRequestChecksStatus,
  PullRequestListItemStatus["tone"]
> = {
  SUCCESS: "success",
  PENDING: "warning",
  FAILURE: "danger",
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
          const statuses: PullRequestListItemStatus[] = [];
          if (state) {
            statuses.push({
              tone: STATE_TONE[state],
              label: summary?.isDraft
                ? t("contextPanel.pullRequests.state.DRAFT")
                : t(`contextPanel.pullRequests.state.${state}`),
            });
          }
          if (checksStatus) {
            statuses.push({
              tone: CHECKS_TONE[checksStatus],
              label: t(`contextPanel.pullRequests.checks.${checksStatus}`),
            });
          }

          return (
            <PullRequestListItem
              key={pullRequest.url}
              repo={pullRequest.repoSlug}
              number={pullRequest.number}
              title={title}
              statuses={statuses}
              ariaLabel={t("contextPanel.pullRequests.open", {
                repo: pullRequest.repoSlug,
                number: pullRequest.number,
              })}
              onOpen={() => void openUrl(pullRequest.url)}
            />
          );
        })}
      </div>
    </Widget>
  );
}
