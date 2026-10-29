import { Eye } from "lucide-react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { getRunningMonitors } from "@/shared/api/monitors";
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

export function MonitorStatus({
  sessionId,
  variant,
  className,
}: MonitorStatusProps) {
  const { t } = useTranslation("chat");
  const { data = [] } = useRunningMonitors(sessionId);
  if (data.length === 0) return null;

  const label = data.map((monitor) => monitor.label).join("\n");
  const text = t("monitorStatus.count", { count: data.length });
  const content = (
    <span
      data-monitor-status={variant}
      role="img"
      aria-label={text}
      className={cn(
        "inline-flex items-center gap-1 text-muted-foreground",
        variant === "sidebar"
          ? "pointer-events-auto size-5 justify-center"
          : "text-xs",
        className,
      )}
    >
      <Eye
        className={variant === "sidebar" ? "size-3.5" : "size-3"}
        aria-hidden="true"
      />
      {variant === "composer" ? <span>{text}</span> : null}
    </span>
  );

  return (
    <Tooltip delayDuration={TOOLTIP_DELAY.restedHover}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{label}</TooltipContent>
    </Tooltip>
  );
}
