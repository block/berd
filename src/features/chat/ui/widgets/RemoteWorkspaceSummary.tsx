import { useTranslation } from "react-i18next";
import { Folder, Server } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import type { RemoteBackendState } from "@/shared/api/remoteHosts";
import { shortenPath } from "./workspacePath";

const HOST_STATE_TINT: Record<RemoteBackendState, string> = {
  ready: "text-success",
  connecting: "text-warning",
  reconnecting: "text-warning",
  disconnected: "text-muted-foreground",
  failed: "text-destructive",
};

/**
 * Compact "this chat lives on <host>" chip, tinted by the SSH backend's
 * connection state with a tooltip naming that state. The v1 host-status
 * surface for remote sessions.
 */
export function RemoteHostBadge({
  host,
  className,
}: {
  host: string;
  className?: string;
}) {
  const { t } = useTranslation(["chat", "settings"]);
  const state = useRemoteHostStore(
    (store) => store.statusByHost[host]?.state ?? "disconnected",
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="remote-host-badge"
          data-host-state={state}
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/80 bg-muted/40 px-1.5 py-0.5 text-xs leading-none",
            HOST_STATE_TINT[state],
            className,
          )}
        >
          <Server className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{host}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {t("chat:remoteSessionGuards.hostBadge.tooltip", {
          host,
          state: t(`settings:remoteHosts.status.${state}`),
        })}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Details-tab workspace block for remote sessions. Local git probes, branch
 * and worktree controls, folder pickers, and terminal affordances all act on
 * the local filesystem, so the remote view degrades to the essentials: the
 * remote folder path plus the host badge.
 */
export function RemoteWorkspaceSummary({
  host,
  workspacePath,
}: {
  host: string;
  workspacePath: string | null;
}) {
  const { t } = useTranslation("chat");

  return (
    <section className="w-full pb-1 text-sm font-normal">
      <div className="space-y-1.5">
        <div className="flex min-h-6 items-center justify-between gap-2">
          <p className="text-sm font-normal text-muted-foreground">
            {t("contextPanel.labels.workspace")}
          </p>
          <RemoteHostBadge host={host} className="shrink-0" />
        </div>
        <div className="flex items-start gap-2 rounded-sm px-2 py-1">
          <Folder className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm leading-[15px] text-foreground">
              {workspacePath
                ? shortenPath(workspacePath)
                : t("contextPanel.empty.folderNotSet")}
            </span>
            <span className="block truncate text-xs leading-none text-muted-foreground">
              {t("remoteSessionGuards.workspaceOnHost", { host })}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
