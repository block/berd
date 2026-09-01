import type { ScheduledJobDto } from "@aaif/goose-sdk";
import { useTranslation } from "react-i18next";
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";

export interface LocalScheduleActions {
  onPause: (scheduleId: string) => void;
  onUnpause: (scheduleId: string) => void;
  onKill: (scheduleId: string) => void;
  onRemove: (scheduleId: string) => void;
  pending: boolean;
}

export function LocalSchedulesPanel({
  schedules,
  actions,
}: {
  schedules: ScheduledJobDto[];
  actions: LocalScheduleActions;
}) {
  const { t } = useTranslation("automations");
  if (schedules.length === 0) return null;

  return (
    <section aria-labelledby="local-schedules-heading" className="space-y-3">
      <div>
        <h2 id="local-schedules-heading" className="text-sm font-medium">
          {t("localSchedules.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("localSchedules.description")}
        </p>
      </div>
      <div className="divide-y rounded-xl border bg-card">
        {schedules.map((schedule) => (
          <div
            key={schedule.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{schedule.id}</div>
              <div className="text-xs text-muted-foreground">
                {schedule.cron}
                {schedule.paused ? ` · ${t("localSchedules.paused")}` : ""}
                {schedule.currentlyRunning
                  ? ` · ${t("localSchedules.running")}`
                  : ""}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {schedule.paused ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actions.pending}
                  onClick={() => actions.onUnpause(schedule.id)}
                >
                  <IconPlayerPlay aria-hidden="true" />
                  {t("localSchedules.resume")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actions.pending || schedule.currentlyRunning}
                  onClick={() => actions.onPause(schedule.id)}
                >
                  <IconPlayerPause aria-hidden="true" />
                  {t("localSchedules.pause")}
                </Button>
              )}
              {schedule.currentlyRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actions.pending}
                  onClick={() => actions.onKill(schedule.id)}
                >
                  <IconPlayerStop aria-hidden="true" />
                  {t("localSchedules.kill")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                destructive
                disabled={actions.pending || schedule.currentlyRunning}
                onClick={() => actions.onRemove(schedule.id)}
              >
                <IconTrash aria-hidden="true" />
                {t("localSchedules.remove")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
