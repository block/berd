import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { PageShell } from "@/shared/ui/page-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import {
  type BuilderbotAutomation,
  type BuilderbotRoutineConfig,
  type BuilderbotTask,
  getBuilderbotAutomations,
  getBuilderbotTasks,
} from "@/features/builderbot/api/builderbot";

const REFETCH_INTERVAL_MS = 15_000;

function StatePanel({
  title,
  body,
  className,
}: {
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-border/60 bg-card px-5 py-4",
        className,
      )}
    >
      <h2 className="text-sm font-normal text-foreground">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm font-light leading-relaxed text-muted-foreground">
        {body}
      </p>
    </section>
  );
}

function ErrorPanel({ message }: { message: string }) {
  const { t } = useTranslation("builderbot");
  return (
    <StatePanel
      title={t("states.errorTitle")}
      body={message || t("states.errorBody")}
    />
  );
}

function LoadingRows() {
  return (
    <div className="space-y-3">
      <div className="h-[86px] rounded-md bg-card" />
      <div className="h-[86px] rounded-md bg-card" />
      <div className="h-[86px] rounded-md bg-card" />
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function descriptionTitle(description: string | undefined, fallback: string) {
  const firstLine = description
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.replace(/^#+\s*/, "") ?? fallback;
}

function compactStatus(value: string | undefined) {
  return (
    value
      ?.replace(/^TASK_STATUS_/, "")
      .replace(/^TRIGGER_RUN_STATUS_/, "")
      .replace(/^ROUTINE_RUN_STATE_/, "")
      .replaceAll("_", " ")
      .toLowerCase() ?? ""
  );
}

function formatTimestamp(
  value: number | undefined,
  formatRelativeTimeToNow: (value: number) => string,
) {
  if (!value) return null;
  return formatRelativeTimeToNow(value);
}

function msFromSec(value: number | undefined) {
  return value ? value * 1000 : undefined;
}

function actionType(routine: BuilderbotRoutineConfig | undefined) {
  switch (routine?.routine_identifier) {
    case "blox-vanilla":
      return "agent";
    case "blox-repo-command":
      return "script";
    default:
      return routine?.routine_identifier ? "routine" : "task";
  }
}

function runAsLabel(routine: BuilderbotRoutineConfig | undefined) {
  return routine?.run_as_service ? "builderbot" : "me";
}

function TaskRow({ task }: { task: BuilderbotTask }) {
  const { t } = useTranslation("builderbot");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const title = descriptionTitle(task.description, task.key ?? t("tasks.item"));
  const updatedAt = formatTimestamp(
    task.updated_at_ms ?? task.created_at_ms,
    formatRelativeTimeToNow,
  );

  return (
    <article className="grid gap-3 rounded-md bg-card px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm text-foreground">{title}</span>
          {task.status ? (
            <Badge variant="secondary">{compactStatus(task.status)}</Badge>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {task.key ? <span>{task.key}</span> : null}
          {task.author ? (
            <span>{t("tasks.by", { user: task.author })}</span>
          ) : null}
          {updatedAt ? <span>{updatedAt}</span> : null}
        </div>
      </div>
      {task.labels?.length ? (
        <div className="flex max-w-md flex-wrap gap-1 md:justify-end">
          {task.labels.slice(0, 3).map((label) => (
            <Badge key={label} variant="outline">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function AutomationRow({ automation }: { automation: BuilderbotAutomation }) {
  const { t } = useTranslation("builderbot");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const updatedAt = formatTimestamp(
    automation.updatedAtMs,
    formatRelativeTimeToNow,
  );
  const nextRun = formatTimestamp(
    automation.kind === "scheduled"
      ? msFromSec(automation.nextRunAtSec)
      : undefined,
    formatRelativeTimeToNow,
  );
  const type = actionType(automation.routine);
  const runAs = runAsLabel(automation.routine);

  return (
    <article className="grid gap-3 rounded-md bg-card px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm text-foreground">
            {automation.reference}
          </span>
          <Badge variant={automation.enabled ? "secondary" : "outline"}>
            {automation.enabled
              ? t("automations.enabled")
              : t("automations.disabled")}
          </Badge>
          <Badge variant="outline">
            {t(`automations.kind.${automation.kind}`)}
          </Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{automation.triggerLabel}</span>
          <span>{t(`automations.action.${type}`)}</span>
          <span>{t(`automations.runAs.${runAs}`)}</span>
          {updatedAt ? <span>{updatedAt}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 md:justify-end">
        {nextRun ? (
          <Badge variant="outline">
            {t("automations.nextRun", { time: nextRun })}
          </Badge>
        ) : null}
        {automation.kind === "routing" ? (
          <Badge variant="outline">
            {t("automations.conditions", {
              count: automation.conditionCount,
              displayCount: automation.conditionCount,
            })}
          </Badge>
        ) : null}
      </div>
    </article>
  );
}

function TasksTab() {
  const { t } = useTranslation("builderbot");
  const query = useQuery({
    queryKey: ["builderbotTasks"],
    queryFn: () => getBuilderbotTasks(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const tasks = query.data?.tasks ?? [];

  if (query.isLoading) return <LoadingRows />;
  if (query.error) {
    return (
      <ErrorPanel message={errorMessage(query.error, t("states.errorBody"))} />
    );
  }
  if (!tasks.length) {
    return (
      <StatePanel title={t("tasks.emptyTitle")} body={t("tasks.emptyBody")} />
    );
  }

  return (
    <section aria-label={t("tasks.title")} className="space-y-3">
      {tasks.map((task, index) => (
        <TaskRow key={task.key ?? index} task={task} />
      ))}
    </section>
  );
}

function AutomationsTab() {
  const { t } = useTranslation("builderbot");
  const query = useQuery({
    queryKey: ["builderbotAutomations"],
    queryFn: () => getBuilderbotAutomations(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const automations = query.data?.automations ?? [];

  if (query.isLoading) return <LoadingRows />;
  if (query.error) {
    return (
      <ErrorPanel message={errorMessage(query.error, t("states.errorBody"))} />
    );
  }
  if (!automations.length) {
    return (
      <StatePanel
        title={t("automations.emptyTitle")}
        body={t("automations.emptyBody")}
      />
    );
  }

  return (
    <section aria-label={t("automations.title")} className="space-y-3">
      {automations.map((automation) => (
        <AutomationRow key={automation.id} automation={automation} />
      ))}
    </section>
  );
}

export function BuilderbotView() {
  const { t } = useTranslation("builderbot");

  return (
    <PageShell contentClassName="gap-6" contentWidth="default">
      <Tabs defaultValue="tasks">
        <TabsList variant="weight">
          <TabsTrigger value="tasks" variant="weight">
            {t("tabs.tasks")}
          </TabsTrigger>
          <TabsTrigger value="automations" variant="weight">
            {t("tabs.automations")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="mt-5">
          <TasksTab />
        </TabsContent>

        <TabsContent value="automations" className="mt-5">
          <AutomationsTab />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
