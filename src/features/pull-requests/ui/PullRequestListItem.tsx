import { IconExternalLink, IconGitPullRequest } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";

export type PullRequestListItemTone =
  | "muted"
  | "primary"
  | "success"
  | "warning"
  | "danger";

export interface PullRequestListItemStatus {
  label: string;
  tone: PullRequestListItemTone;
}

interface PullRequestListItemProps {
  repo: string;
  number: number | string;
  title: string;
  statuses?: readonly PullRequestListItemStatus[];
  timestamp?: string | null;
  ariaLabel: string;
  onOpen: () => void;
  className?: string;
}

const STATUS_DOT_CLASS: Record<PullRequestListItemTone, string> = {
  muted: "bg-muted-foreground",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

export function PullRequestListItem({
  repo,
  number,
  title,
  statuses = [],
  timestamp,
  ariaLabel,
  onOpen,
  className,
}: PullRequestListItemProps) {
  const normalizedNumber = String(number).replace(/^#/, "");

  return (
    <button
      type="button"
      data-slot="pull-request-list-item"
      className={cn(
        "group flex w-full min-w-0 items-start gap-2 overflow-hidden rounded-xl bg-muted/60 px-3 py-2.5 text-left normal-case text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label={ariaLabel}
      onClick={onOpen}
    >
      <IconGitPullRequest
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="block min-w-0 flex-1 space-y-0.5 overflow-hidden">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <span className="min-w-0 flex-1 truncate font-medium">
            {repo} #{normalizedNumber}
          </span>
          {timestamp ? (
            <span className="shrink-0 tabular-nums">{timestamp}</span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-sm font-medium leading-4 text-foreground">
          {title}
        </span>
        {statuses.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-muted-foreground text-xs">
            {statuses.map((status) => (
              <span
                key={`${status.tone}:${status.label}`}
                className="flex min-w-0 items-center gap-1"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT_CLASS[status.tone],
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{status.label}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <IconExternalLink
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </button>
  );
}
