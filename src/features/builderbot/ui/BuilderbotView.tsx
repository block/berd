import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconPencil,
  IconX,
} from "@tabler/icons-react";
import { ExternalLinkIcon } from "lucide-react";
import { PageShell } from "@/shared/ui/page-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { DetailField as SharedDetailField } from "@/shared/ui/detail-field";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { Input } from "@/shared/ui/input";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type {
  AppNavigationUpdateOptions,
  BuilderbotNavigationRoute,
} from "@/app/types/appNavigation";
import {
  type BuilderbotAutomation,
  type BuilderbotRoutineConfig,
  type BuilderbotTask,
  type UpdateBuilderbotRoutingRuleRequest,
  type UpdateBuilderbotScheduledTriggerRequest,
  getBuilderbotTaskLinks,
  getBuilderbotAutomations,
  getBuilderbotTasks,
  updateBuilderbotRoutingRule,
  updateBuilderbotScheduledTrigger,
} from "@/features/builderbot/api/builderbot";
import {
  buildBuilderbotCronSchedule,
  builderbotDefaultTimeZone,
  builderbotTimeZoneOptions,
  parseBuilderbotCronSchedule,
  type BuilderbotScheduleForm,
} from "@/features/builderbot/lib/builderbotSchedule";

const REFETCH_INTERVAL_MS = 15_000;
const FIELD_CLASS = "rounded-sm border-transparent bg-card";

const WEEKDAY_OPTIONS = [
  { value: "0", labelKey: "edit.weekdays.sunday" },
  { value: "1", labelKey: "edit.weekdays.monday" },
  { value: "2", labelKey: "edit.weekdays.tuesday" },
  { value: "3", labelKey: "edit.weekdays.wednesday" },
  { value: "4", labelKey: "edit.weekdays.thursday" },
  { value: "5", labelKey: "edit.weekdays.friday" },
  { value: "6", labelKey: "edit.weekdays.saturday" },
] as const;

function formatTimeLabel(hhmm: string): string {
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number.parseInt(hRaw ?? "0", 10);
  const m = Number.parseInt(mRaw ?? "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}:${m.toString().padStart(2, "0")} ${period}`;
}

const TIME_SLOT_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  const value = `${h.toString().padStart(2, "0")}:${m
    .toString()
    .padStart(2, "0")}`;
  return { value, label: formatTimeLabel(value) };
});

type BuilderbotOverviewTab = "tasks" | "automations";

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
      <div className="h-[84px] rounded-md bg-card" />
      <div className="h-[84px] rounded-md bg-card" />
      <div className="h-[84px] rounded-md bg-card" />
    </div>
  );
}

function LoadingDetail() {
  return (
    <PageShell contentClassName="gap-6" contentWidth="default">
      <div className="space-y-4">
        <div className="h-7 w-64 rounded-md bg-muted" />
        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="h-80 rounded-md bg-muted" />
          <div className="h-96 rounded-md bg-muted" />
        </div>
      </div>
    </PageShell>
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

function taskStatusIcon(value: string | undefined) {
  const status = compactStatus(value);
  if (!status) return null;

  if (/\b(completed|complete|success|succeeded|done|ok)\b/.test(status)) {
    return IconCheck;
  }

  if (/\b(cancelled|canceled)\b/.test(status)) {
    return IconX;
  }

  if (/\b(pending|queued|running|in progress|started)\b/.test(status)) {
    return IconLoader2;
  }

  return null;
}

function runStatusIcon(value: string | undefined) {
  const status = compactStatus(value);
  if (!status) return null;

  if (/\b(completed|complete|success|succeeded|done|ok)\b/.test(status)) {
    return { Icon: IconCheck, label: status, className: "text-success" };
  }

  if (/\b(failed|failure|error|errored|cancelled|canceled)\b/.test(status)) {
    return { Icon: IconX, label: status, className: "text-destructive" };
  }

  return null;
}

function formatTimestamp(
  value: number | undefined,
  formatRelativeTimeToNow: (value: number) => string,
) {
  if (!value) return null;
  return formatRelativeTimeToNow(value);
}

function formatLongRelativeTimestamp(
  value: number | undefined,
  formatting: ReturnType<typeof useLocaleFormatting>,
) {
  if (!value) return null;

  const diffMs = value - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const options: Intl.RelativeTimeFormatOptions = {
    numeric: "auto",
    style: "long",
  };

  if (Math.abs(diffSeconds) < 45) {
    return formatting.formatRelativeTime(0, "second", options);
  }

  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 45) {
    return formatting.formatRelativeTime(diffMinutes, "minute", options);
  }

  const diffHours = Math.round(diffMs / 3_600_000);
  if (Math.abs(diffHours) < 24) {
    return formatting.formatRelativeTime(diffHours, "hour", options);
  }

  const diffDays = Math.round(diffMs / 86_400_000);
  if (Math.abs(diffDays) < 45) {
    return formatting.formatRelativeTime(diffDays, "day", options);
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 18) {
    return formatting.formatRelativeTime(diffMonths, "month", options);
  }

  return formatting.formatRelativeTime(
    Math.round(diffDays / 365),
    "year",
    options,
  );
}

function msFromSec(value: number | undefined) {
  return value ? value * 1000 : undefined;
}

function formatDetailTimestamp(
  value: number | undefined,
  formatting: ReturnType<typeof useLocaleFormatting>,
) {
  if (!value) return null;
  return formatting.formatDate(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type AutomationActionType = "agent" | "script" | "routine" | "task";

function actionType(
  routine: BuilderbotRoutineConfig | undefined,
): AutomationActionType {
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

function sourceLabelKey(source: string | undefined) {
  const normalized = source
    ?.trim()
    .replace(/^EVENT_SOURCE_/i, "")
    .replace(/-/g, "_")
    .toLowerCase();
  switch (normalized) {
    case "github":
    case "linear":
    case "jira":
    case "actionable_ci":
    case "pagerduty":
      return normalized;
    default:
      return null;
  }
}

function fallbackSourceLabel(source: string | undefined) {
  const cleaned = source
    ?.trim()
    .replace(/^EVENT_SOURCE_/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((word) =>
      word.toLowerCase() === "ci"
        ? "CI"
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function routingSourceLabel(
  source: string | undefined,
  t: (key: string) => string,
) {
  const key = sourceLabelKey(source);
  return key ? t(`automations.source.${key}`) : fallbackSourceLabel(source);
}

function automationTriggerLabel(
  automation: BuilderbotAutomation,
  t: (key: string) => string,
) {
  return automation.kind === "routing"
    ? routingSourceLabel(automation.triggerLabel, t)
    : automation.triggerLabel;
}

function weekdayLabel(
  weekday: string,
  t: (key: string) => string,
): string | null {
  const option = WEEKDAY_OPTIONS.find((item) => item.value === weekday);
  return option ? t(option.labelKey) : null;
}

function scheduledOverviewLabel(
  automation: Extract<BuilderbotAutomation, { kind: "scheduled" }>,
  t: (key: string, options?: Record<string, string>) => string,
) {
  const schedule = parseBuilderbotCronSchedule(automation.triggerLabel);
  switch (schedule.preset) {
    case "hourly":
      return t("automations.schedule.hourly");
    case "daily":
      return t("automations.schedule.dailyAt", {
        time: formatTimeLabel(schedule.time),
      });
    case "weekdays":
      return t("automations.schedule.weekdaysAt", {
        time: formatTimeLabel(schedule.time),
      });
    case "weekly": {
      const day = weekdayLabel(schedule.weekday, t);
      return t("automations.schedule.weeklyAt", {
        day: day ?? t("automations.schedule.weekly"),
        time: formatTimeLabel(schedule.time),
      });
    }
    case "custom":
      return t("automations.schedule.custom");
    default:
      return t("automations.kind.scheduled");
  }
}

function automationOverviewTriggerLabel(
  automation: BuilderbotAutomation,
  t: (key: string, options?: Record<string, string>) => string,
) {
  if (automation.kind === "scheduled") {
    return scheduledOverviewLabel(automation, t);
  }
  return t("automations.triggeredBy", {
    source: automationTriggerLabel(automation, t),
  });
}

function automationOverviewStatusLabel(
  automation: BuilderbotAutomation,
  nextRun: string | null,
  t: (key: string, options?: Record<string, string>) => string,
) {
  if (!automation.enabled) {
    return t("automations.paused");
  }
  if (automation.kind === "scheduled") {
    return nextRun ? t("automations.nextRun", { time: nextRun }) : null;
  }
  return t("automations.listening");
}

function formatPayload(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

type EditablePayload =
  | {
      kind: "prompt";
      text: string;
    }
  | {
      kind: "payload";
      text: string;
    };

function parsePayloadObject(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function editableAutomationPayload(
  automation: BuilderbotAutomation | undefined,
): EditablePayload {
  if (!automation) return { kind: "payload", text: "" };
  const inputPayload = automation.routine?.input_payload;
  const parsedInputPayload = parsePayloadObject(inputPayload);
  if (typeof parsedInputPayload?.prompt === "string") {
    return { kind: "prompt", text: parsedInputPayload.prompt };
  }

  const rawPayload =
    inputPayload ??
    (automation.kind === "scheduled"
      ? automation.source.task_config_json
      : undefined);
  return { kind: "payload", text: formatPayload(rawPayload) ?? "" };
}

function buildRoutineWithPrompt(
  routine: BuilderbotRoutineConfig,
  prompt: string,
) {
  const payload = parsePayloadObject(routine.input_payload) ?? {};
  return {
    ...routine,
    input_payload: JSON.stringify({ ...payload, prompt }),
  };
}

function buildRoutineWithPayload(
  routine: BuilderbotRoutineConfig,
  payload: string,
) {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  try {
    return {
      ...routine,
      input_payload: JSON.stringify(JSON.parse(trimmed)),
    };
  } catch {
    return {
      ...routine,
      input_payload: trimmed,
    };
  }
}

function scheduledTriggerReplacement(
  automation: Extract<BuilderbotAutomation, { kind: "scheduled" }>,
  patch: UpdateBuilderbotScheduledTriggerRequest,
): UpdateBuilderbotScheduledTriggerRequest {
  const source = automation.source;
  const replacement: UpdateBuilderbotScheduledTriggerRequest = {
    reference: automation.reference,
    enabled: source.enabled ?? automation.enabled,
    cron_expression: source.cron_expression ?? automation.triggerLabel,
    routine: source.routine ?? automation.routine,
    task_config_json: source.task_config_json,
    owners: source.owners ?? automation.owners,
  };
  const merged = { ...replacement, ...patch };
  merged.reference = automation.reference;
  return merged;
}

function routingRuleReplacement(
  automation: Extract<BuilderbotAutomation, { kind: "routing" }>,
  patch: UpdateBuilderbotRoutingRuleRequest,
): UpdateBuilderbotRoutingRuleRequest {
  const source = automation.source;
  const replacement: UpdateBuilderbotRoutingRuleRequest = {
    reference: automation.reference,
    enabled: source.enabled ?? automation.enabled,
    source: source.source ?? automation.triggerLabel,
    conditions: source.conditions ?? [],
    outcome_labels: source.outcome_labels ?? [],
    task_status: source.task_status,
    description_template: source.description_template,
    idempotency_key_template: source.idempotency_key_template,
    max_matches_per_idempotency: source.max_matches_per_idempotency,
    idempotency_enabled: source.idempotency_enabled,
    routine: source.routine ?? automation.routine,
    owners: source.owners ?? automation.owners,
  };
  const merged = { ...replacement, ...patch };
  merged.reference = automation.reference;
  return merged;
}

function builderbotServiceAccount(automation: BuilderbotAutomation) {
  return automation.routine?.run_as_service
    ? automation.routine.run_as_service
    : automation.kind === "routing"
      ? "sa-builderbot"
      : "builderbot";
}

function routineWithRunAs(
  routine: BuilderbotRoutineConfig,
  automation: BuilderbotAutomation,
  runAs: "me" | "builderbot",
) {
  const nextRoutine = { ...routine };
  if (runAs === "builderbot") {
    nextRoutine.run_as_service = builderbotServiceAccount(automation);
  } else {
    delete nextRoutine.run_as_service;
  }
  return nextRoutine;
}

function readOnlyFieldValue(value: React.ReactNode) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center rounded-sm px-3 py-1 text-sm text-muted-foreground",
        FIELD_CLASS,
      )}
    >
      <span className="min-w-0 truncate">{value}</span>
    </div>
  );
}

function FieldLabel({
  htmlFor,
  label,
  tooltip,
  tooltipLabel,
  children,
}: {
  htmlFor?: string;
  label: string;
  tooltip?: React.ReactNode;
  tooltipLabel?: string;
  children: React.ReactNode;
}) {
  const labelContent = (
    <div className="mb-2 flex h-4 items-center gap-1 text-xs text-muted-foreground">
      {htmlFor ? (
        <label htmlFor={htmlFor}>{label}</label>
      ) : (
        <span>{label}</span>
      )}
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-my-1.5 -ml-1"
              aria-label={tooltipLabel ?? label}
            >
              <IconInfoCircle aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent
            sideOffset={6}
            className="w-64 max-w-[calc(100vw-2rem)] text-left leading-snug ![text-wrap:wrap]"
          >
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );

  if (tooltip) {
    return (
      <div className="block text-sm">
        {labelContent}
        {children}
      </div>
    );
  }

  return (
    <label className="block text-sm" htmlFor={htmlFor}>
      <span className="mb-2 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function taskRouteKey(task: BuilderbotTask, index: number) {
  return task.key?.trim() || `task-${index}`;
}

function DetailField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <SharedDetailField
      label={label}
      className={cn("min-w-0", wide && "md:col-span-2")}
      contentClassName="break-words font-light"
    >
      {children}
    </SharedDetailField>
  );
}

function DetailLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      onClick={() => void openUrl(href)}
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
    </Button>
  );
}

function BadgeList({
  values,
  fallback,
}: {
  values: string[] | undefined;
  fallback: string;
}) {
  if (!values?.length) return <span>{fallback}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </span>
  );
}

function DetailPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs leading-4 font-medium text-muted-foreground">
        {title}
      </h2>
      <div className="rounded-md bg-card p-4">{children}</div>
    </section>
  );
}

function TaskRow({
  task,
  routeKey,
  onOpen,
}: {
  task: BuilderbotTask;
  routeKey: string;
  onOpen: (taskKey: string) => void;
}) {
  const { t } = useTranslation("builderbot");
  const formatting = useLocaleFormatting();
  const title = descriptionTitle(task.description, task.key ?? t("tasks.item"));
  const updatedAt = formatTimestamp(
    task.updated_at_ms ?? task.created_at_ms,
    formatting.formatRelativeTimeToNow,
  );
  const statusLabel = compactStatus(task.status);
  const StatusIcon = taskStatusIcon(task.status);

  return (
    <button
      type="button"
      className="group grid min-h-[84px] w-full gap-3 rounded-md bg-card px-6 py-4 text-left transition-[background-color,box-shadow,border-color] duration-200 hover:shadow-card hover:ring-1 hover:ring-inset hover:ring-border/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      aria-label={t("tasks.openDetails", { title })}
      onClick={() => onOpen(routeKey)}
    >
      <span className="min-w-0">
        <span className="block truncate text-base font-normal text-foreground">
          {title}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {updatedAt ? <span>{updatedAt}</span> : null}
        </span>
      </span>
      {statusLabel ? (
        <span className="flex justify-start md:justify-end">
          {StatusIcon ? (
            <span
              aria-label={statusLabel}
              role="img"
              className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors group-hover:text-foreground"
            >
              <StatusIcon aria-hidden="true" className="size-4" />
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">{statusLabel}</span>
          )}
        </span>
      ) : null}
    </button>
  );
}

function AutomationRow({
  automation,
  onOpen,
}: {
  automation: BuilderbotAutomation;
  onOpen: (automationId: string) => void;
}) {
  const { t } = useTranslation("builderbot");
  const formatting = useLocaleFormatting();
  const nextRunLabel = formatLongRelativeTimestamp(
    automation.kind === "scheduled"
      ? msFromSec(automation.nextRunAtSec)
      : undefined,
    formatting,
  );
  const triggerLabel = automationOverviewTriggerLabel(automation, t);
  const statusLabel = automationOverviewStatusLabel(
    automation,
    nextRunLabel,
    t,
  );

  return (
    <button
      type="button"
      className="group grid min-h-[84px] w-full gap-3 rounded-md bg-card px-6 py-4 text-left transition-[background-color,box-shadow,border-color] duration-200 hover:shadow-card hover:ring-1 hover:ring-inset hover:ring-border/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      aria-label={t("automations.openDetails", {
        reference: automation.displayName,
      })}
      onClick={() => onOpen(automation.id)}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-base font-normal text-foreground">
            {automation.displayName}
          </span>
        </span>
        <span className="mt-1.5 block truncate text-sm text-muted-foreground">
          {triggerLabel}
        </span>
      </span>
      <span className="text-sm text-muted-foreground md:max-w-64 md:truncate md:text-right">
        {statusLabel}
      </span>
    </button>
  );
}

function TasksTab({ onOpenTask }: { onOpenTask: (taskKey: string) => void }) {
  const { t } = useTranslation("builderbot");
  const {
    data: tasksData,
    error: tasksError,
    isLoading: isTasksLoading,
  } = useQuery({
    queryKey: ["builderbotTasks"],
    queryFn: () => getBuilderbotTasks(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const tasks = tasksData?.tasks ?? [];

  if (isTasksLoading) return <LoadingRows />;
  if (tasksError) {
    return (
      <ErrorPanel message={errorMessage(tasksError, t("states.errorBody"))} />
    );
  }
  if (!tasks.length) {
    return (
      <StatePanel title={t("tasks.emptyTitle")} body={t("tasks.emptyBody")} />
    );
  }

  return (
    <section aria-label={t("tasks.title")} className="space-y-3">
      {tasks.map((task, index) => {
        const key = taskRouteKey(task, index);
        return (
          <TaskRow key={key} task={task} routeKey={key} onOpen={onOpenTask} />
        );
      })}
    </section>
  );
}

function AutomationsTab({
  onOpenAutomation,
}: {
  onOpenAutomation: (automationId: string) => void;
}) {
  const { t } = useTranslation("builderbot");
  const {
    data: automationsData,
    error: automationsError,
    isLoading: isAutomationsLoading,
  } = useQuery({
    queryKey: ["builderbotAutomations"],
    queryFn: () => getBuilderbotAutomations(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const automations = automationsData?.automations ?? [];

  if (isAutomationsLoading) return <LoadingRows />;
  if (automationsError) {
    return (
      <ErrorPanel
        message={errorMessage(automationsError, t("states.errorBody"))}
      />
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
        <AutomationRow
          key={automation.id}
          automation={automation}
          onOpen={onOpenAutomation}
        />
      ))}
    </section>
  );
}

function TaskDetailPage({
  taskKey,
  onBreadcrumbLabelChange,
}: {
  taskKey: string;
  onBreadcrumbLabelChange?: (label: string | null) => void;
}) {
  const { t } = useTranslation("builderbot");
  const formatting = useLocaleFormatting();
  const {
    data: tasksData,
    error: tasksError,
    isLoading: isTasksLoading,
  } = useQuery({
    queryKey: ["builderbotTasks"],
    queryFn: () => getBuilderbotTasks(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const tasks = tasksData?.tasks ?? [];
  const task = tasks.find(
    (candidate, index) => taskRouteKey(candidate, index) === taskKey,
  );
  const title = task
    ? descriptionTitle(task.description, task.key ?? t("tasks.item"))
    : taskKey;
  const taskLinks = task ? getBuilderbotTaskLinks(task) : null;
  const createdAtDetail = formatDetailTimestamp(
    task?.created_at_ms,
    formatting,
  );
  const updatedAtDetail = formatDetailTimestamp(
    task?.updated_at_ms,
    formatting,
  );

  useEffect(() => {
    onBreadcrumbLabelChange?.(title);
    return () => onBreadcrumbLabelChange?.(null);
  }, [onBreadcrumbLabelChange, title]);

  if (isTasksLoading) return <LoadingDetail />;
  if (tasksError) {
    return (
      <PageShell contentClassName="gap-6" contentWidth="default">
        <ErrorPanel message={errorMessage(tasksError, t("states.errorBody"))} />
      </PageShell>
    );
  }
  if (!task) {
    return (
      <PageShell contentClassName="gap-6" contentWidth="default">
        <StatePanel
          title={t("details.notFoundTitle")}
          body={t("details.notFoundBody")}
        />
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="gap-6" contentWidth="default">
      <div className="grid min-h-0 gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <DetailField label={t("details.key")}>
            {task.key ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.status")}>
            {task.status
              ? compactStatus(task.status)
              : t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.author")}>
            {task.author ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.assignee")}>
            {task.assignee ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.latestActor")}>
            {task.latest_actor ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.created")}>
            {createdAtDetail ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.updated")}>
            {updatedAtDetail ?? t("details.notAvailable")}
          </DetailField>
          <DetailField label={t("details.labels")}>
            <BadgeList
              values={task.labels}
              fallback={t("details.notAvailable")}
            />
          </DetailField>
        </aside>

        <div className="min-w-0 space-y-4">
          <DetailPanel title={t("details.description")}>
            {task.description ? (
              <div className="min-h-40 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {task.description}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {t("details.notAvailable")}
              </div>
            )}
          </DetailPanel>

          <DetailPanel title={t("details.links")}>
            <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
              <DetailField label={t("details.artifacts")}>
                {taskLinks?.artifactsUrl ? (
                  <DetailLink href={taskLinks.artifactsUrl}>
                    {taskLinks.artifactCount !== undefined
                      ? t("tasks.artifactsLink", {
                          count: taskLinks.artifactCount,
                          displayCount: taskLinks.artifactCount,
                        })
                      : t("tasks.artifactsLinkUnknown")}
                  </DetailLink>
                ) : taskLinks?.artifactCount !== undefined ? (
                  t("tasks.artifactsCount", {
                    count: taskLinks.artifactCount,
                    displayCount: taskLinks.artifactCount,
                  })
                ) : (
                  t("details.notAvailable")
                )}
              </DetailField>
              <DetailField label={t("details.thread")}>
                {taskLinks?.threadUrl ? (
                  <DetailLink href={taskLinks.threadUrl}>
                    {t("tasks.threadLink")}
                  </DetailLink>
                ) : (
                  t("details.notAvailable")
                )}
              </DetailField>
            </div>
          </DetailPanel>
        </div>
      </div>
    </PageShell>
  );
}

function AutomationDetailPage({
  automationId,
  onBreadcrumbLabelChange,
}: {
  automationId: string;
  onBreadcrumbLabelChange?: (label: string | null) => void;
}) {
  const { t } = useTranslation("builderbot");
  const formatting = useLocaleFormatting();
  const queryClient = useQueryClient();
  const {
    data: automationsData,
    error: automationsError,
    isLoading: isAutomationsLoading,
  } = useQuery({
    queryKey: ["builderbotAutomations"],
    queryFn: () => getBuilderbotAutomations(),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const automation = automationsData?.automations.find(
    (candidate) => candidate.id === automationId,
  );
  const scheduledAutomation =
    automation?.kind === "scheduled" ? automation : null;
  const routingAutomation = automation?.kind === "routing" ? automation : null;
  const type = actionType(automation?.routine);
  const runAs = runAsLabel(automation?.routine);
  const triggerLabel = automation ? automationTriggerLabel(automation, t) : "";
  const editablePayload = editableAutomationPayload(automation);
  const [enabledDraft, setEnabledDraft] = useState(
    automation?.enabled ?? false,
  );
  const [timeZoneDraft, setTimeZoneDraft] = useState(
    builderbotDefaultTimeZone(),
  );
  const initialSchedule = parseBuilderbotCronSchedule(
    scheduledAutomation?.source.cron_expression,
    timeZoneDraft,
  );
  const [scheduleDraft, setScheduleDraft] =
    useState<BuilderbotScheduleForm>(initialSchedule);
  const [runAsDraft, setRunAsDraft] = useState<"me" | "builderbot">(runAs);
  const [payloadDraft, setPayloadDraft] = useState(editablePayload.text);
  const [isEditingPayload, setIsEditingPayload] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previousAutomation, setPreviousAutomation] = useState(automation);
  const [previousAutomationTimeZone, setPreviousAutomationTimeZone] =
    useState(timeZoneDraft);
  if (
    previousAutomation !== automation ||
    previousAutomationTimeZone !== timeZoneDraft
  ) {
    const automationChanged = previousAutomation?.id !== automation?.id;
    setPreviousAutomation(automation);
    setPreviousAutomationTimeZone(timeZoneDraft);

    if (!automation) {
      setIsEditingPayload(false);
      setLocalError(null);
    } else {
      setEnabledDraft(automation.enabled);
      setRunAsDraft(runAsLabel(automation.routine));
      if (scheduledAutomation) {
        setScheduleDraft(
          parseBuilderbotCronSchedule(
            scheduledAutomation.source.cron_expression,
            timeZoneDraft,
          ),
        );
      }
      if (automationChanged || !isEditingPayload) {
        setPayloadDraft(editableAutomationPayload(automation).text);
      }
      if (automationChanged) {
        setIsEditingPayload(false);
        setLocalError(null);
      }
    }
  }
  const timeZoneOptions = useMemo(
    () => builderbotTimeZoneOptions(timeZoneDraft),
    [timeZoneDraft],
  );
  const timeOptions = useMemo(() => {
    if (
      !scheduleDraft.time ||
      TIME_SLOT_OPTIONS.some((option) => option.value === scheduleDraft.time)
    ) {
      return TIME_SLOT_OPTIONS;
    }
    return [
      { value: scheduleDraft.time, label: formatTimeLabel(scheduleDraft.time) },
      ...TIME_SLOT_OPTIONS,
    ];
  }, [scheduleDraft.time]);
  const updateMutation = useMutation({
    mutationFn: ({
      kind,
      reference,
      request,
    }: {
      kind: BuilderbotAutomation["kind"];
      reference: string;
      request:
        | Parameters<typeof updateBuilderbotScheduledTrigger>[1]
        | Parameters<typeof updateBuilderbotRoutingRule>[1];
    }) =>
      kind === "scheduled"
        ? updateBuilderbotScheduledTrigger(
            reference,
            request as Parameters<typeof updateBuilderbotScheduledTrigger>[1],
          )
        : updateBuilderbotRoutingRule(
            reference,
            request as Parameters<typeof updateBuilderbotRoutingRule>[1],
          ),
    onSuccess: () => {
      setLocalError(null);
      void queryClient.invalidateQueries({
        queryKey: ["builderbotAutomations"],
      });
    },
    onError: (error) => {
      setLocalError(errorMessage(error, t("states.errorBody")));
      void queryClient.invalidateQueries({
        queryKey: ["builderbotAutomations"],
      });
    },
  });
  const lastRunAt =
    automation?.kind === "scheduled"
      ? formatDetailTimestamp(
          msFromSec(automation.source.last_run_at_sec),
          formatting,
        )
      : null;
  const nextRunAt =
    automation?.kind === "scheduled"
      ? formatDetailTimestamp(
          msFromSec(automation.source.next_run_at_sec),
          formatting,
        )
      : null;
  const lastRunStatus = runStatusIcon(scheduledAutomation?.lastStatus);
  const isSaving = updateMutation.isPending;
  const currentError = localError;
  const payloadChanged = payloadDraft.trim() !== editablePayload.text.trim();

  useEffect(() => {
    onBreadcrumbLabelChange?.(automation?.displayName ?? automationId);
    return () => onBreadcrumbLabelChange?.(null);
  }, [automation?.displayName, automationId, onBreadcrumbLabelChange]);

  const updateScheduledAutomation = (
    patch: UpdateBuilderbotScheduledTriggerRequest,
  ) => {
    if (!scheduledAutomation) return;
    setLocalError(null);
    updateMutation.mutate({
      kind: "scheduled",
      reference: scheduledAutomation.reference,
      request: scheduledTriggerReplacement(scheduledAutomation, patch),
    });
  };

  const updateRoutingAutomation = (
    patch: UpdateBuilderbotRoutingRuleRequest,
  ) => {
    if (!routingAutomation) return;
    setLocalError(null);
    updateMutation.mutate({
      kind: "routing",
      reference: routingAutomation.reference,
      request: routingRuleReplacement(routingAutomation, patch),
    });
  };

  const saveScheduledAutomation = (
    patch: UpdateBuilderbotScheduledTriggerRequest,
  ) => {
    if (!scheduledAutomation) return Promise.resolve();
    setLocalError(null);
    return updateMutation.mutateAsync({
      kind: "scheduled",
      reference: scheduledAutomation.reference,
      request: scheduledTriggerReplacement(scheduledAutomation, patch),
    });
  };

  const saveRoutingAutomation = (patch: UpdateBuilderbotRoutingRuleRequest) => {
    if (!routingAutomation) return Promise.resolve();
    setLocalError(null);
    return updateMutation.mutateAsync({
      kind: "routing",
      reference: routingAutomation.reference,
      request: routingRuleReplacement(routingAutomation, patch),
    });
  };

  const saveEnabled = (enabled: boolean) => {
    setEnabledDraft(enabled);
    if (!automation || enabled === automation.enabled) return;
    if (scheduledAutomation) {
      updateScheduledAutomation({ enabled });
      return;
    }
    updateRoutingAutomation({ enabled });
  };

  const saveSchedule = (next: Partial<BuilderbotScheduleForm>) => {
    if (!scheduledAutomation) return;
    const nextSchedule = { ...scheduleDraft, ...next };
    setScheduleDraft(nextSchedule);
    const nextCron = buildBuilderbotCronSchedule(nextSchedule, timeZoneDraft);
    if (!nextCron || nextCron === scheduledAutomation.source.cron_expression) {
      return;
    }
    updateScheduledAutomation({ cron_expression: nextCron });
  };

  const saveTimeZone = (nextTimeZone: string) => {
    setTimeZoneDraft(nextTimeZone);
    if (!scheduledAutomation) return;
    const nextCron = buildBuilderbotCronSchedule(scheduleDraft, nextTimeZone);
    if (!nextCron || nextCron === scheduledAutomation.source.cron_expression) {
      return;
    }
    updateScheduledAutomation({ cron_expression: nextCron });
  };

  const saveRunAs = (nextRunAs: "me" | "builderbot") => {
    setRunAsDraft(nextRunAs);
    if (!automation?.routine || nextRunAs === runAs) return;
    const routine = routineWithRunAs(automation.routine, automation, nextRunAs);
    if (scheduledAutomation) {
      updateScheduledAutomation({ routine });
      return;
    }
    updateRoutingAutomation({ routine });
  };

  const startEditingPayload = () => {
    setPayloadDraft(editablePayload.text);
    setLocalError(null);
    setIsEditingPayload(true);
  };

  const cancelEditingPayload = () => {
    setPayloadDraft(editablePayload.text);
    setLocalError(null);
    setIsEditingPayload(false);
  };

  const savePayload = async () => {
    const trimmedPayload = payloadDraft.trim();
    if (!trimmedPayload) {
      setLocalError(t("edit.payloadRequired"));
      return;
    }
    if (automation?.routine) {
      const routine =
        editablePayload.kind === "prompt"
          ? buildRoutineWithPrompt(automation.routine, trimmedPayload)
          : buildRoutineWithPayload(automation.routine, trimmedPayload);
      if (!routine) {
        setLocalError(t("edit.payloadRequired"));
        return;
      }
      try {
        if (scheduledAutomation) {
          await saveScheduledAutomation({ routine });
        } else {
          await saveRoutingAutomation({ routine });
        }
        setIsEditingPayload(false);
      } catch {
        // onError owns the user-facing message; keep the draft open.
      }
      return;
    }
    if (!scheduledAutomation) return;
    try {
      await saveScheduledAutomation({ task_config_json: trimmedPayload });
      setIsEditingPayload(false);
    } catch {
      // onError owns the user-facing message; keep the draft open.
    }
  };

  if (isAutomationsLoading) return <LoadingDetail />;
  if (automationsError) {
    return (
      <PageShell contentClassName="gap-6" contentWidth="default">
        <ErrorPanel
          message={errorMessage(automationsError, t("states.errorBody"))}
        />
      </PageShell>
    );
  }
  if (!automation) {
    return (
      <PageShell contentClassName="gap-6" contentWidth="default">
        <StatePanel
          title={t("details.notFoundTitle")}
          body={t("details.notFoundBody")}
        />
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="gap-6" contentWidth="default">
      <div className="grid min-h-0 gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <section className={scheduledAutomation ? "space-y-10" : "space-y-4"}>
            <div className="space-y-4">
              <FieldLabel
                label={t("details.reference")}
                tooltip={t("details.tooltips.reference")}
                tooltipLabel={t("details.tooltips.referenceLabel")}
              >
                {readOnlyFieldValue(automation.reference)}
              </FieldLabel>

              <FieldLabel
                label={t("details.enabled")}
                htmlFor="builderbot-enabled"
              >
                <div
                  className={cn(
                    "flex min-h-9 items-center justify-between gap-3 rounded-sm px-3 py-1",
                    FIELD_CLASS,
                  )}
                >
                  <span className="text-sm text-foreground">
                    {enabledDraft
                      ? t("automations.listening")
                      : t("automations.paused")}
                  </span>
                  <Switch
                    id="builderbot-enabled"
                    checked={enabledDraft}
                    onCheckedChange={saveEnabled}
                    disabled={isSaving}
                    aria-label={t("details.enabled")}
                  />
                </div>
              </FieldLabel>

              <FieldLabel
                label={t("details.triggerType")}
                tooltip={t(`details.tooltips.triggerType.${automation.kind}`)}
                tooltipLabel={t("details.tooltips.triggerType.label")}
              >
                {readOnlyFieldValue(t(`automations.kind.${automation.kind}`))}
              </FieldLabel>
            </div>

            {scheduledAutomation ? (
              <div className="space-y-4">
                <FieldLabel
                  label={t("edit.fields.scheduleRepeats")}
                  htmlFor="builderbot-schedule-preset"
                >
                  <Select
                    value={scheduleDraft.preset}
                    onValueChange={(value) =>
                      saveSchedule({
                        preset: value as BuilderbotScheduleForm["preset"],
                      })
                    }
                    disabled={isSaving}
                  >
                    <SelectTrigger
                      id="builderbot-schedule-preset"
                      className={cn("w-full", FIELD_CLASS)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly">
                        {t("edit.schedulePresets.hourly")}
                      </SelectItem>
                      <SelectItem value="daily">
                        {t("edit.schedulePresets.daily")}
                      </SelectItem>
                      <SelectItem value="weekdays">
                        {t("edit.schedulePresets.weekdays")}
                      </SelectItem>
                      <SelectItem value="weekly">
                        {t("edit.schedulePresets.weekly")}
                      </SelectItem>
                      <SelectItem value="custom">
                        {t("edit.schedulePresets.custom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FieldLabel>

                {scheduleDraft.preset === "weekly" ? (
                  <FieldLabel
                    label={t("edit.fields.scheduleDay")}
                    htmlFor="builderbot-schedule-day"
                  >
                    <Select
                      value={scheduleDraft.weekday}
                      onValueChange={(weekday) => saveSchedule({ weekday })}
                      disabled={isSaving}
                    >
                      <SelectTrigger
                        id="builderbot-schedule-day"
                        className={cn("w-full", FIELD_CLASS)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldLabel>
                ) : null}

                {scheduleDraft.preset !== "none" &&
                scheduleDraft.preset !== "hourly" &&
                scheduleDraft.preset !== "custom" ? (
                  <FieldLabel
                    label={t("edit.fields.scheduleTime")}
                    htmlFor="builderbot-schedule-time"
                  >
                    <Select
                      value={scheduleDraft.time}
                      onValueChange={(time) => saveSchedule({ time })}
                      disabled={isSaving}
                    >
                      <SelectTrigger
                        id="builderbot-schedule-time"
                        className={cn("w-full", FIELD_CLASS)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {timeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldLabel>
                ) : null}

                {scheduleDraft.preset === "custom" ? (
                  <FieldLabel
                    label={t("edit.fields.scheduleCustom")}
                    htmlFor="builderbot-schedule-custom"
                  >
                    <Input
                      id="builderbot-schedule-custom"
                      value={scheduleDraft.customSchedule}
                      onChange={(event) =>
                        setScheduleDraft((current) => ({
                          ...current,
                          customSchedule: event.target.value,
                        }))
                      }
                      onBlur={() =>
                        saveSchedule({
                          customSchedule: scheduleDraft.customSchedule,
                        })
                      }
                      placeholder={t("edit.fields.schedulePlaceholder")}
                      disabled={isSaving}
                      className={FIELD_CLASS}
                    />
                  </FieldLabel>
                ) : null}

                <FieldLabel
                  label={t("details.timeZone")}
                  htmlFor="builderbot-timezone"
                >
                  <SearchableSelect
                    id="builderbot-timezone"
                    value={timeZoneDraft}
                    options={timeZoneOptions}
                    onValueChange={saveTimeZone}
                    disabled={isSaving}
                    searchPlaceholder={t("edit.fields.timeZoneSearch")}
                    emptyLabel={t("edit.fields.timeZoneEmpty")}
                    className={FIELD_CLASS}
                  />
                </FieldLabel>
              </div>
            ) : (
              <FieldLabel
                label={t("details.source")}
                tooltip={t("details.tooltips.source")}
                tooltipLabel={t("details.tooltips.sourceLabel")}
              >
                {readOnlyFieldValue(triggerLabel || t("details.notAvailable"))}
              </FieldLabel>
            )}

            <div className="space-y-4">
              <FieldLabel
                label={t("details.actionType")}
                tooltip={t(`details.tooltips.actionType.${type}`)}
                tooltipLabel={t("details.tooltips.actionType.label")}
              >
                {readOnlyFieldValue(t(`automations.action.${type}`))}
              </FieldLabel>

              {automation.routine ? (
                <FieldLabel
                  label={t("details.runAs")}
                  htmlFor="builderbot-run-as"
                >
                  <Select
                    value={runAsDraft}
                    onValueChange={(value) =>
                      saveRunAs(value as "me" | "builderbot")
                    }
                    disabled={isSaving}
                  >
                    <SelectTrigger
                      id="builderbot-run-as"
                      className={cn("w-full", FIELD_CLASS)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="me">
                        {t("automations.runAs.me")}
                      </SelectItem>
                      <SelectItem value="builderbot">
                        {t("automations.runAs.builderbot")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FieldLabel>
              ) : (
                <FieldLabel label={t("details.runAs")}>
                  {readOnlyFieldValue(t(`automations.runAs.${runAs}`))}
                </FieldLabel>
              )}
            </div>
          </section>
        </aside>

        <div className="min-w-0 space-y-4">
          {currentError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {currentError}
            </div>
          ) : null}

          {scheduledAutomation ? (
            <section>
              <span
                aria-hidden="true"
                className="mb-2 block text-xs text-transparent"
              >
                {t("details.lastRun")}
              </span>
              <div className="rounded-md bg-card p-4">
                <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {t("details.lastRun")}
                    </p>
                    <div className="flex items-center gap-2 text-sm text-foreground">
                      {lastRunStatus ? (
                        <lastRunStatus.Icon
                          aria-label={lastRunStatus.label}
                          role="img"
                          className={cn(
                            "size-4 shrink-0",
                            lastRunStatus.className,
                          )}
                        />
                      ) : null}
                      <span>{lastRunAt ?? t("details.notAvailable")}</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {t("details.nextRun")}
                    </p>
                    <div className="text-sm text-foreground">
                      {nextRunAt ?? t("details.notAvailable")}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <div className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-xs font-normal text-muted-foreground">
                {editablePayload.kind === "prompt"
                  ? t("details.prompt")
                  : t("details.payload")}
              </h2>
              {scheduledAutomation || routingAutomation?.routine ? (
                isEditingPayload ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={cancelEditingPayload}
                      disabled={isSaving}
                    >
                      {t("actions.cancel")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      onClick={savePayload}
                      disabled={
                        isSaving || !payloadChanged || !payloadDraft.trim()
                      }
                    >
                      {isSaving
                        ? t("actions.saving")
                        : t("actions.saveChanges")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={startEditingPayload}
                    disabled={isSaving}
                    aria-label={t("details.editPayload")}
                    leftIcon={<IconPencil aria-hidden="true" />}
                  >
                    {t("actions.edit")}
                  </Button>
                )
              ) : null}
            </div>
            <section className="rounded-md bg-card p-4">
              {isEditingPayload ? (
                <Textarea
                  aria-label={
                    editablePayload.kind === "prompt"
                      ? t("details.prompt")
                      : t("details.payload")
                  }
                  value={payloadDraft}
                  onChange={(event) => setPayloadDraft(event.target.value)}
                  disabled={isSaving}
                  placeholder={t("details.noPayload")}
                  rows={12}
                  className="min-h-[360px] resize-y rounded-sm text-[14px] leading-relaxed"
                />
              ) : editablePayload.text.trim() ? (
                <div className="min-h-40 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {editablePayload.text}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {t("details.noPayload")}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

interface BuilderbotViewProps {
  route?: BuilderbotNavigationRoute;
  onRouteChange?: (
    route: BuilderbotNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
}

export function BuilderbotView({
  route,
  onRouteChange,
  onBreadcrumbLabelChange,
}: BuilderbotViewProps = {}) {
  const { t } = useTranslation("builderbot");
  const isRouteControlled = route !== undefined;
  const [internalRoute, setInternalRoute] = useState<BuilderbotNavigationRoute>(
    { surface: "overview", tab: "tasks" },
  );
  const currentRoute = route ?? internalRoute;
  const overviewTab: BuilderbotOverviewTab =
    currentRoute.surface === "overview"
      ? (currentRoute.tab ?? "tasks")
      : "tasks";

  const setNavigationRoute = (
    nextRoute: BuilderbotNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => {
    if (!isRouteControlled) {
      setInternalRoute(nextRoute);
    }
    onRouteChange?.(nextRoute, options);
  };

  useEffect(() => {
    if (currentRoute.surface === "overview") {
      onBreadcrumbLabelChange?.(null);
    }
  }, [currentRoute.surface, onBreadcrumbLabelChange]);

  if (currentRoute.surface === "task") {
    return (
      <TaskDetailPage
        taskKey={currentRoute.taskKey}
        onBreadcrumbLabelChange={onBreadcrumbLabelChange}
      />
    );
  }

  if (currentRoute.surface === "automation") {
    return (
      <AutomationDetailPage
        automationId={currentRoute.automationId}
        onBreadcrumbLabelChange={onBreadcrumbLabelChange}
      />
    );
  }

  return (
    <PageShell contentClassName="gap-6" contentWidth="default">
      <Tabs
        value={overviewTab}
        onValueChange={(value) =>
          setNavigationRoute({
            surface: "overview",
            tab: value as BuilderbotOverviewTab,
          })
        }
      >
        <TabsList variant="weight" className="gap-5">
          <TabsTrigger value="tasks" variant="weight">
            {t("tabs.tasks")}
          </TabsTrigger>
          <TabsTrigger value="automations" variant="weight">
            {t("tabs.automations")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="mt-6">
          <TasksTab
            onOpenTask={(taskKey) =>
              setNavigationRoute({ surface: "task", taskKey })
            }
          />
        </TabsContent>

        <TabsContent value="automations" className="mt-6">
          <AutomationsTab
            onOpenAutomation={(automationId) =>
              setNavigationRoute({ surface: "automation", automationId })
            }
          />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
