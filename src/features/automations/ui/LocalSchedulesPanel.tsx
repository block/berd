import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { ScheduledJobDto } from "@aaif/goose-sdk";
import {
  LOCAL_SCHEDULES_QUERY_KEY,
  LOCAL_SCHEDULES_REFETCH_INTERVAL_MS,
  listLocalSchedules,
} from "@/features/automations/api/localSchedules";
import { EmptyState } from "@/features/automations/ui/RunOutput";
import { Button } from "@/shared/ui/button";

function scheduleSourceLabel(schedule: ScheduledJobDto): string {
  const source = schedule.source.trim();
  const fileName = source.split(/[\\/]/).at(-1);
  return fileName || source;
}

function localErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function LocalSchedulesPanel() {
  const { t } = useTranslation("automations");
  const schedulesQuery = useQuery({
    queryKey: LOCAL_SCHEDULES_QUERY_KEY,
    queryFn: listLocalSchedules,
    refetchInterval: LOCAL_SCHEDULES_REFETCH_INTERVAL_MS,
  });
  const schedules = schedulesQuery.data ?? [];

  return (
    <section aria-labelledby="local-schedules-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="local-schedules-heading" className="text-sm font-medium">
            {t("localSchedules.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("localSchedules.description")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void schedulesQuery.refetch()}
          disabled={schedulesQuery.isFetching}
        >
          <IconRefresh aria-hidden="true" />
          {t("actions.refreshShort")}
        </Button>
      </div>

      {schedulesQuery.isLoading ? (
        <div
          role="status"
          aria-label={t("localSchedules.loading")}
          className="h-20 animate-pulse rounded-xl border bg-card"
        />
      ) : schedulesQuery.error && schedules.length === 0 ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <div className="flex items-center gap-2 font-medium text-destructive">
            <IconAlertTriangle aria-hidden="true" />
            {t("localSchedules.loadErrorTitle")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {localErrorMessage(
              schedulesQuery.error,
              t("localSchedules.loadErrorDescription"),
            )}
          </p>
        </div>
      ) : (
        <>
          {schedulesQuery.error ? (
            <div role="status" className="text-xs text-destructive">
              {t("localSchedules.refreshError", {
                error: localErrorMessage(
                  schedulesQuery.error,
                  t("localSchedules.loadErrorDescription"),
                ),
              })}
            </div>
          ) : null}
          {schedules.length === 0 ? (
            <EmptyState
              title={t("localSchedules.emptyTitle")}
              body={t("localSchedules.emptyBody")}
            />
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {schedules.map((schedule) => (
                <article
                  key={schedule.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {schedule.id}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t("localSchedules.sourceLabel", {
                        name: scheduleSourceLabel(schedule),
                      })}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="font-mono">{schedule.cron}</span>
                      {schedule.paused
                        ? ` · ${t("localSchedules.paused")}`
                        : ""}
                      {schedule.currentlyRunning
                        ? ` · ${t("localSchedules.running")}`
                        : ""}
                      {schedule.lastRun
                        ? ` · ${t("localSchedules.lastRun", { time: schedule.lastRun })}`
                        : ""}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
