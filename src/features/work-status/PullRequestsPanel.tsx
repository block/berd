import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  MonitorCog,
  RefreshCw,
  TestTube2,
} from "lucide-react";

import {
  PullRequestListItem,
  type PullRequestListItemStatus,
} from "@/features/pull-requests/ui/PullRequestListItem";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { Badge } from "@/shared/ui/badge";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { ScrollIntentArea } from "@/shared/ui/scroll-intent-area";
import { ContentToolbarIconButton } from "@/shared/ui/content-toolbar-icon-button";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { useWorkStatusStore } from "./workStatusStore";
import { WORK_STATUS_LABEL_KEYS } from "./statusModel";
import {
  openWorkStatusUrl,
  WORK_STATUS_REFRESH_EVENT,
} from "./workStatusNative";
import type {
  WorkStatusErrorCode,
  WorkStatusItem,
  WorkStatusState,
} from "./types";

interface PullRequestsPanelProps {
  className?: string;
}

type PullRequestsPreviewState =
  | "live"
  | "no-prs"
  | "github"
  | "error"
  | "rate-limit"
  | "stale-error"
  | "truncated"
  | "statuses";

export function PullRequestsPanel({ className }: PullRequestsPanelProps) {
  const { t } = useTranslation("common");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const [previewState, setPreviewState] =
    useState<PullRequestsPreviewState>("live");
  const pullRequests = useWorkStatusStore(
    (state) => state.snapshot.pullRequests,
  );
  const errors = useWorkStatusStore((state) => state.snapshot.errors);
  const isTruncated = useWorkStatusStore((state) => state.snapshot.isTruncated);
  const pullRequestsRefreshedAt = useWorkStatusStore(
    (state) => state.pullRequestsRefreshedAt,
  );
  const isManualRefreshPending = useWorkStatusStore(
    (state) => state.isManualRefreshPending,
  );
  const lastManualRefreshSucceeded = useWorkStatusStore(
    (state) => state.lastManualRefreshSucceeded,
  );
  const setManualRefreshPending = useWorkStatusStore(
    (state) => state.setManualRefreshPending,
  );
  const projects = useProjectStore((state) => state.projects);
  const [showRefreshFeedback, setShowRefreshFeedback] = useState(false);
  const previousManualRefreshPendingRef = useRef(isManualRefreshPending);
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");

  useEffect(() => {
    if (previousManualRefreshPendingRef.current && !isManualRefreshPending) {
      setRefreshAnnouncement(
        lastManualRefreshSucceeded
          ? t("workStatus.updatedNow")
          : t("workStatus.refreshFailed"),
      );
    }
    previousManualRefreshPendingRef.current = isManualRefreshPending;
  }, [isManualRefreshPending, lastManualRefreshSucceeded, t]);
  const groups = useMemo(
    () => groupItemsByProject(pullRequests, projects),
    [pullRequests, projects],
  );
  const blockingAuthError =
    pullRequests.length === 0
      ? errors.find((error) => error.id === "github-auth")
      : undefined;
  const blockingError =
    pullRequests.length === 0
      ? errors.find((error) => error.id !== "github-auth")
      : undefined;
  const otherErrors = errors.filter(
    (error) => error !== blockingAuthError && error !== blockingError,
  );

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg",
        className,
      )}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {refreshAnnouncement}
      </span>
      <div className="mx-3 flex shrink-0 items-center gap-3 border-b py-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-accent">
          <GitPullRequest className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium text-sm">
            {t("workStatus.title")}
          </h2>
          <p className="truncate text-muted-foreground text-xs">
            {isManualRefreshPending
              ? t("workStatus.updating")
              : pullRequestsRefreshedAt
                ? t("workStatus.updated", {
                    time: formatRelativeTimeToNow(pullRequestsRefreshedAt),
                  })
                : t("workStatus.collecting")}
          </p>
        </div>
        {import.meta.env.DEV ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <ContentToolbarIconButton
                type="button"
                size="icon-top-bar"
                className="transition-none"
                aria-label={t("workStatus.preview.ariaLabel")}
              >
                <TestTube2 />
              </ContentToolbarIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                {t("workStatus.preview.devOnly")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPreviewState("live")}>
                {t("workStatus.preview.live")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("no-prs")}>
                {t("workStatus.preview.noPrs")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("github")}>
                {t("workStatus.preview.githubDisconnected")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("error")}>
                {t("workStatus.preview.connectionError")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("rate-limit")}>
                {t("workStatus.preview.rateLimited")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("stale-error")}>
                {t("workStatus.preview.staleError")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("truncated")}>
                {t("workStatus.preview.truncated")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPreviewState("statuses")}>
                {t("workStatus.preview.statuses")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <ContentToolbarIconButton
          type="button"
          size="icon-top-bar"
          className="transition-none"
          aria-label={
            isManualRefreshPending
              ? t("workStatus.refreshing")
              : t("workStatus.refresh")
          }
          aria-busy={isManualRefreshPending}
          disabled={isManualRefreshPending}
          onClick={() => {
            setRefreshAnnouncement(t("workStatus.updating"));
            setShowRefreshFeedback(false);
            setManualRefreshPending(true);
            window.requestAnimationFrame(() => setShowRefreshFeedback(true));
            window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
          }}
        >
          <RefreshCw
            className={cn(
              showRefreshFeedback && "animate-[spin_500ms_linear_1]",
            )}
            onAnimationEnd={() => setShowRefreshFeedback(false)}
          />
        </ContentToolbarIconButton>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden py-2">
        <ScrollIntentArea
          className={cn(
            "flex-1",
            previewState !== "live" ||
              blockingAuthError ||
              blockingError ||
              pullRequestsRefreshedAt === null ||
              pullRequests.length === 0
              ? "[&>div]:h-full"
              : undefined,
          )}
        >
          {previewState === "no-prs" ? (
            <NoPullRequestsEmptyState />
          ) : previewState === "github" ? (
            <GitHubConnectionEmptyState />
          ) : previewState === "error" ? (
            <PullRequestsErrorPreview />
          ) : previewState === "rate-limit" ? (
            <PullRequestsErrorPreview errorCode="rateLimited" />
          ) : previewState === "stale-error" ? (
            <PullRequestStatusPreview />
          ) : previewState === "truncated" ? (
            <PullRequestStatusPreview />
          ) : previewState === "statuses" ? (
            <PullRequestStatusPreview />
          ) : blockingAuthError ? (
            <GitHubConnectionEmptyState />
          ) : blockingError ? (
            <PullRequestsErrorPreview errorCode={blockingError.code} />
          ) : pullRequestsRefreshedAt === null ? (
            <PullRequestsLoadingState label={t("workStatus.loading")} />
          ) : pullRequests.length === 0 ? (
            <NoPullRequestsEmptyState />
          ) : (
            <div
              className={cn(
                "min-w-0 space-y-3 pb-3",
                SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
              )}
            >
              {groups.map((group) => (
                <PullRequestProjectGroup
                  key={group.project?.id ?? "no-project"}
                  group={group}
                />
              ))}
            </div>
          )}
        </ScrollIntentArea>
        {(previewState === "live" &&
          pullRequests.length > 0 &&
          !blockingAuthError &&
          !blockingError) ||
        previewState === "statuses" ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-b from-transparent to-popover"
          />
        ) : null}
      </div>

      {isTruncated || previewState === "truncated" ? (
        <div className="shrink-0 border-t px-4 py-2 text-muted-foreground text-xs">
          {t("workStatus.truncated", { count: 250 })}
        </div>
      ) : null}

      {previewState === "stale-error" ? (
        <div className="shrink-0 border-t px-4 py-2 text-muted-foreground text-xs">
          {t("workStatus.error.network")}
        </div>
      ) : null}

      {otherErrors.length > 0 ? (
        <div className="max-h-24 shrink-0 space-y-2 overflow-auto border-t px-4 py-2">
          {otherErrors.map((error) => (
            <div
              key={error.id}
              className="flex items-start gap-2 text-muted-foreground text-xs"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {t(`workStatus.error.${error.code}`)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PullRequestsLoadingState({ label }: { label: string }) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col justify-start space-y-3 py-1",
        SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
      )}
      role="status"
      aria-label={label}
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2 px-3 py-2">
          <Skeleton className="h-4 w-2/3 rounded-sm" />
          <Skeleton className="h-3 w-1/3 rounded-sm" />
          <Skeleton className="h-3 w-1/2 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

function NoPullRequestsEmptyState() {
  const { t } = useTranslation("common");
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center px-8 py-10 text-center",
        SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted">
        <CheckCircle2 className="size-5 text-foreground" aria-hidden />
      </span>
      <p className="text-sm text-foreground">{t("workStatus.empty.title")}</p>
      <p className="mt-1 max-w-64 text-muted-foreground text-xs">
        {t("workStatus.empty.description")}
      </p>
    </div>
  );
}

function PullRequestsErrorPreview({
  errorCode,
}: {
  errorCode?: WorkStatusErrorCode;
}) {
  const { t } = useTranslation("common");
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center px-8 py-10 text-center",
        SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted">
        <MonitorCog className="size-5 text-foreground" aria-hidden />
      </span>
      <p className="text-sm text-foreground">{t("workStatus.error.title")}</p>
      <p className="mt-1 max-w-72 text-muted-foreground text-xs">
        {t(`workStatus.error.${errorCode ?? "unknown"}`)}
      </p>
    </div>
  );
}

function GitHubConnectionEmptyState() {
  const { t } = useTranslation("common");
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center px-8 py-10 text-center",
        SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted">
        <GitPullRequest className="size-5 text-foreground" aria-hidden />
      </span>
      <p className="text-sm text-foreground">
        {t("workStatus.githubDisconnected.title")}
      </p>
      <p className="mt-1 max-w-72 text-muted-foreground text-xs">
        {t("workStatus.githubDisconnected.description")}
      </p>
      <code className="mt-3 rounded-sm bg-muted px-2 py-1 font-mono text-xs">
        gh auth login
      </code>
    </div>
  );
}

const PREVIEW_PR_STATES: WorkStatusState[] = [
  "draft",
  "awaitingApproval",
  "changesRequested",
  "checksFailing",
  "readyToMerge",
  "mergeBlocked",
];

function PullRequestStatusPreview() {
  const { t } = useTranslation("common");
  return (
    <div
      className={cn(
        "min-w-0 space-y-0.5 pb-3",
        SIDEBAR_ROW_HORIZONTAL_INSET_CLASS,
      )}
    >
      {PREVIEW_PR_STATES.map((status, index) => (
        <PullRequestRow
          key={status}
          item={{
            id: `preview-${status}`,
            title: t(`workStatus.preview.titles.${status}`),
            subtitle: `#${201 + index}`,
            groupName: "example/work-status",
            source: "github",
            status,
            updatedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
            destination: { type: "url", url: "https://github.com/" },
          }}
        />
      ))}
    </div>
  );
}

interface PullRequestProjectGroupModel {
  project: ProjectInfo | null;
  items: WorkStatusItem[];
}

function PullRequestProjectGroup({
  group,
}: {
  group: PullRequestProjectGroupModel;
}) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(true);
  const title = group.project?.name ?? t("workStatus.noProject");

  return (
    <div className="min-w-0">
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-sm px-3 py-1 text-left text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          SIDEBAR_GROUP_LABEL_TEXT_CLASS,
        )}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          {group.project ? (
            <ProjectIcon
              icon={group.project.icon}
              color={group.project.color}
              projectId={group.project.id}
              className="size-[18px]"
              imageClassName="size-4 rounded-[4px]"
            />
          ) : (
            <span
              aria-hidden="true"
              className="size-4 rounded-[4px] border border-border bg-muted"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Badge
          variant="secondary"
          className="flex size-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] tabular-nums"
        >
          {formatCount(group.items.length)}
        </Badge>
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      <CollapseReveal open={expanded}>
        <div className="min-w-0 space-y-0.5 pb-1">
          {group.items.map((item) => (
            <PullRequestRow key={item.id} item={item} />
          ))}
        </div>
      </CollapseReveal>
    </div>
  );
}

function PullRequestRow({ item }: { item: WorkStatusItem }) {
  const { t } = useTranslation("common");
  const { formatDate } = useLocaleFormatting();
  const number = item.subtitle ?? item.destination.url.split("/").at(-1) ?? "";
  const statuses: PullRequestListItemStatus[] = [
    {
      label: t(WORK_STATUS_LABEL_KEYS[item.status]),
      tone: toneForStatus(item.status),
    },
  ];

  return (
    <PullRequestListItem
      repo={item.groupName}
      number={number}
      title={item.title}
      statuses={statuses}
      timestamp={formatPullRequestTimestamp(item.updatedAt, formatDate)}
      ariaLabel={`${item.title} · ${item.groupName} ${item.subtitle ?? ""}`.trim()}
      className="ml-[38px] w-[calc(100%-38px)]"
      onOpen={() => {
        openWorkStatusUrl(item.destination.url).catch((error) => {
          console.error("Failed to open pull request:", error);
          toast.error(t("workStatus.openError"));
        });
      }}
    />
  );
}

function groupItemsByProject(
  items: WorkStatusItem[],
  projects: ProjectInfo[],
): PullRequestProjectGroupModel[] {
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
  );
  const grouped = new Map<string, PullRequestProjectGroupModel>();
  for (const item of items) {
    const project = item.projectId
      ? (projectsById.get(item.projectId) ?? null)
      : null;
    const key = project?.id ?? "no-project";
    const group = grouped.get(key) ?? { project, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }

  const sorted = Array.from(grouped.values()).map((group) => ({
    ...group,
    items: [...group.items].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
  }));
  const noProject = sorted.find((group) => group.project === null);
  return [
    ...sorted
      .filter((group) => group.project !== null)
      .sort(
        (a, b) =>
          (a.project?.order ?? Number.MAX_SAFE_INTEGER) -
          (b.project?.order ?? Number.MAX_SAFE_INTEGER),
      ),
    ...(noProject ? [noProject] : []),
  ];
}

function formatCount(count: number): string {
  return count > 999 ? "999+" : String(count);
}

function toneForStatus(
  status: WorkStatusState,
): PullRequestListItemStatus["tone"] {
  switch (status) {
    case "readyToMerge":
      return "success";
    case "awaitingApproval":
    case "checksPending":
      return "warning";
    case "changesRequested":
    case "checksFailing":
    case "mergeBlocked":
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

function formatPullRequestTimestamp(
  value: string,
  formatDate: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return formatDate(
    date,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  );
}
