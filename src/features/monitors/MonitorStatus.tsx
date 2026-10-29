import { Eye } from "lucide-react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getRunningMonitors,
  stopRunningMonitor,
  type RunningMonitor,
} from "@/shared/api/monitors";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";

const fallbackQueryClient = new QueryClient();

export function useRunningMonitors(sessionId: string | null | undefined) {
  const queryClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: ["running-monitors"],
      queryFn: getRunningMonitors,
      enabled: Boolean(queryClient && sessionId),
      staleTime: 1000,
      refetchInterval: 2000,
      retry: false,
      select: (monitors) =>
        monitors.filter((monitor) => monitor.sessionId === sessionId),
    },
    queryClient ?? fallbackQueryClient,
  );
  return { ...query, data: query.isError || !sessionId ? [] : query.data };
}

interface MonitorStatusProps {
  sessionId: string | null | undefined;
  variant: "sidebar" | "composer";
  className?: string;
}

function MonitorDetails({ monitor }: { monitor: RunningMonitor }) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [error, setError] = useState(false);
  const stopping = monitor.stopping || stopRequested;

  async function stop() {
    setStopRequested(true);
    setError(false);
    try {
      await stopRunningMonitor(monitor);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["running-monitors"] });
    } catch {
      setStopRequested(false);
      setError(true);
      void queryClient.invalidateQueries({ queryKey: ["running-monitors"] });
    }
  }

  return (
    <section
      aria-label={monitor.label}
      className="space-y-2 border-t border-border py-3 first:border-0 first:pt-0 last:pb-0"
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 break-words text-sm font-medium">
          {monitor.label}
        </h4>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(stopping ? "monitorStatus.stopping" : "monitorStatus.running")}
        </span>
      </div>
      <dl className="space-y-1 text-xs">
        <div>
          <dt className="text-muted-foreground">
            {t("monitorStatus.command")}
          </dt>
          <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted p-2 font-mono">
            {monitor.command?.length
              ? monitor.command.map((arg) => JSON.stringify(arg)).join(" ")
              : t("monitorStatus.detailsUnavailable")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">
            {t("monitorStatus.started")}
          </dt>
          <dd>
            {monitor.startedAt
              ? formatDate(monitor.startedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t("monitorStatus.detailsUnavailable")}
          </dd>
        </div>
      </dl>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("monitorStatus.stopFailed")}
        </p>
      ) : null}
      {confirming && !stopping ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("monitorStatus.stopDescription")}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setConfirming(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              destructive
              size="xs"
              onClick={() => void stop()}
            >
              {t("monitorStatus.confirmStop")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            destructive
            size="xs"
            disabled={stopping || !monitor.instanceId}
            onClick={() => setConfirming(true)}
          >
            {t(stopping ? "monitorStatus.stopping" : "monitorStatus.stop")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function MonitorStatus({
  sessionId,
  variant,
  className,
}: MonitorStatusProps) {
  const { t } = useTranslation("chat");
  const { data = [] } = useRunningMonitors(sessionId);
  if (data.length === 0) return null;
  const text = t("monitorStatus.count", { count: data.length });

  if (variant === "composer") {
    return (
      <div className={cn("min-w-0", className)} data-monitor-status="composer">
        <Popover key={sessionId}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              flush
              size="xs"
              className="max-w-full gap-1 text-xs"
              aria-label={t("monitorStatus.inspect", { count: data.length })}
            >
              <Eye className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {t("monitorStatus.watching", { label: data[0].label })}
              </span>
              {data.length > 1 ? (
                <span className="shrink-0">
                  {t("monitorStatus.more", { count: data.length - 1 })}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="max-h-[min(28rem,70vh)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
            aria-label={t("monitorStatus.title")}
          >
            <h3 className="mb-3 text-sm font-medium">{text}</h3>
            {data.map((monitor) => (
              <MonitorDetails
                key={monitor.instanceId || monitor.stateKey}
                monitor={monitor}
              />
            ))}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  return (
    <Tooltip delayDuration={TOOLTIP_DELAY.restedHover}>
      <TooltipTrigger asChild>
        <span
          data-monitor-status="sidebar"
          role="img"
          aria-label={text}
          className={cn(
            "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground",
            className,
          )}
        >
          <Eye className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">
        {data.map((monitor) => monitor.label).join("\n")}
      </TooltipContent>
    </Tooltip>
  );
}
