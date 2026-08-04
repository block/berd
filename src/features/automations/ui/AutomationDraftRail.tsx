import {
  IconAlertTriangle,
  IconCheck,
  IconSparkles,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AutomationBuilderStatus,
  AutomationDraft,
  AutomationDraftState,
} from "@/features/automations/api/automationBuilder";
import {
  buildScheduleFromForm,
  defaultTimeZone,
  parseScheduleForm,
  supportedTimeZones,
  type SchedulePreset,
} from "@/features/automations/lib/automationFormatting";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { FORM_FIELD_CLASS } from "@/shared/ui/form-field-tokens";
import { Input } from "@/shared/ui/input";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";

interface AutomationDraftRailProps {
  draftState: AutomationDraftState;
  error: string | null;
  isSubmitting: boolean;
  isEditing?: boolean;
  sessionId: string | null;
  status: AutomationBuilderStatus;
  onApprove: () => void;
  onDraftOverride: (overrides: Partial<AutomationDraft>) => void;
  className?: string;
}

const WEEKDAY_OPTIONS = [
  { value: "0", labelKey: "edit.weekdays.sunday" },
  { value: "1", labelKey: "edit.weekdays.monday" },
  { value: "2", labelKey: "edit.weekdays.tuesday" },
  { value: "3", labelKey: "edit.weekdays.wednesday" },
  { value: "4", labelKey: "edit.weekdays.thursday" },
  { value: "5", labelKey: "edit.weekdays.friday" },
  { value: "6", labelKey: "edit.weekdays.saturday" },
] as const;

const FIELD_CLASS = FORM_FIELD_CLASS;

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
  const value = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  return { value, label: formatTimeLabel(value) };
});

function statusLabel(
  status: AutomationBuilderStatus,
  t: (key: string) => string,
) {
  switch (status) {
    case "processing":
      return t("builder.status.processing");
    case "needClientInput":
      return t("builder.status.needClientInput");
    case "cancelling":
      return t("builder.status.cancelling");
    case "idle":
      return t("builder.status.idle");
    default:
      return t("builder.status.ready");
  }
}

export function AutomationDraftRail({
  className,
  draftState,
  error,
  isSubmitting,
  isEditing = false,
  sessionId,
  status,
  onApprove,
  onDraftOverride,
}: AutomationDraftRailProps) {
  const { t } = useTranslation("automations");
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const draft = draftState.draft;
  const draftToolRequestId = draft?.toolRequestId ?? null;
  const [scheduleState, setScheduleState] = useState(() => ({
    toolRequestId: draftToolRequestId,
    value: parseScheduleForm(draft?.schedule),
  }));
  const schedule =
    scheduleState.toolRequestId === draftToolRequestId
      ? scheduleState.value
      : parseScheduleForm(draft?.schedule);
  const instructionsValue = draft
    ? (draft.humanReadableInstructions.length
        ? draft.humanReadableInstructions
        : draft.instructions
      ).join("\n")
    : "";

  const timeZoneOptions = useMemo(
    () =>
      [
        ...new Set([
          draft?.timeZone ?? defaultTimeZone(),
          defaultTimeZone(),
          ...supportedTimeZones(),
        ]),
      ]
        .sort((a, b) => a.localeCompare(b))
        .map((tz) => ({ value: tz, label: tz })),
    [draft?.timeZone],
  );

  const timeOptions = useMemo(() => {
    if (
      !schedule.time ||
      TIME_SLOT_OPTIONS.some((option) => option.value === schedule.time)
    ) {
      return TIME_SLOT_OPTIONS;
    }
    return [
      { value: schedule.time, label: formatTimeLabel(schedule.time) },
      ...TIME_SLOT_OPTIONS,
    ];
  }, [schedule.time]);

  const statusText = draftState.failed
    ? t("builder.failed")
    : draftState.created
      ? t("builder.created")
      : draftState.createRequested || isSubmitting
        ? t("builder.creating")
        : statusLabel(status, t);

  function updateSchedule(next: {
    preset?: SchedulePreset;
    time?: string;
    weekday?: string;
    customSchedule?: string;
  }) {
    const nextForm = {
      preset: next.preset ?? schedule.preset,
      time: next.time ?? schedule.time,
      weekday: next.weekday ?? schedule.weekday,
      customSchedule: next.customSchedule ?? schedule.customSchedule,
    };
    setScheduleState({ toolRequestId: draftToolRequestId, value: nextForm });
    const nextSchedule = buildScheduleFromForm(nextForm);
    onDraftOverride({ schedule: nextSchedule });
  }

  const copySessionId = useCallback(async () => {
    if (!sessionId || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(sessionId);
    setCopiedSessionId(true);
    window.setTimeout(() => setCopiedSessionId(false), 1_500);
  }, [sessionId]);

  return (
    <aside
      className={cn(
        "flex min-h-0 w-full flex-col rounded-md bg-card p-5",
        className,
      )}
      aria-label={t("builder.previewAriaLabel")}
    >
      <div className="flex flex-col gap-3 rounded-full bg-card/40 px-4 py-3 text-sm text-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <IconSparkles className="size-4 shrink-0 text-foreground" />
          <span className="truncate text-xs text-muted-foreground">
            {isEditing
              ? t("builder.editingEyebrow")
              : t("builder.previewEyebrow")}
          </span>
        </span>
        {draft?.title ? (
          <p className="truncate text-sm font-medium text-foreground">
            {draft.title}
          </p>
        ) : null}
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
        {draftState.blockedToolRequest && !draft ? (
          <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2">
              <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
              <div>
                <h3 className="text-sm font-normal text-foreground">
                  {t("builder.blockedTitle")}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("builder.blockedBody")}
                </p>
              </div>
            </div>
          </section>
        ) : !draft ? (
          <section className="rounded-md bg-card/40 p-4 text-sm text-muted-foreground">
            {t("builder.previewEmptyBody")}
          </section>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm" htmlFor="draft-title">
              <span className="mb-2 block text-xs text-muted-foreground">
                {t("edit.fields.title")}
              </span>
              <Input
                id="draft-title"
                value={draft.title ?? ""}
                onChange={(event) =>
                  onDraftOverride({ title: event.target.value })
                }
                disabled={isSubmitting}
                className={FIELD_CLASS}
              />
            </label>

            <label className="block text-sm" htmlFor="draft-schedule-preset">
              <span className="mb-2 block text-xs text-muted-foreground">
                {t("edit.fields.scheduleRepeats")}
              </span>
              <Select
                value={schedule.preset}
                onValueChange={(value) =>
                  updateSchedule({ preset: value as SchedulePreset })
                }
                disabled={isSubmitting}
              >
                <SelectTrigger
                  id="draft-schedule-preset"
                  className={cn("w-full", FIELD_CLASS)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("edit.schedulePresets.none")}
                  </SelectItem>
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
            </label>

            {schedule.preset === "weekly" ? (
              <label className="block text-sm" htmlFor="draft-schedule-day">
                <span className="mb-2 block text-xs text-muted-foreground">
                  {t("edit.fields.scheduleDay")}
                </span>
                <Select
                  value={schedule.weekday}
                  onValueChange={(value) => updateSchedule({ weekday: value })}
                  disabled={isSubmitting}
                >
                  <SelectTrigger
                    id="draft-schedule-day"
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
              </label>
            ) : null}

            {schedule.preset !== "none" &&
            schedule.preset !== "hourly" &&
            schedule.preset !== "custom" ? (
              <label className="block text-sm" htmlFor="draft-schedule-time">
                <span className="mb-2 block text-xs text-muted-foreground">
                  {t("edit.fields.scheduleTime")}
                </span>
                <Select
                  value={schedule.time}
                  onValueChange={(value) => updateSchedule({ time: value })}
                  disabled={isSubmitting}
                >
                  <SelectTrigger
                    id="draft-schedule-time"
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
              </label>
            ) : null}

            {schedule.preset === "custom" ? (
              <label className="block text-sm" htmlFor="draft-schedule-custom">
                <span className="mb-2 block text-xs text-muted-foreground">
                  {t("edit.fields.scheduleCustom")}
                </span>
                <Input
                  id="draft-schedule-custom"
                  value={schedule.customSchedule}
                  onChange={(event) =>
                    updateSchedule({ customSchedule: event.target.value })
                  }
                  placeholder={t("edit.fields.schedulePlaceholder")}
                  disabled={isSubmitting}
                  className={FIELD_CLASS}
                />
              </label>
            ) : null}

            <label className="block text-sm" htmlFor="draft-timezone">
              <span className="mb-2 block text-xs text-muted-foreground">
                {t("edit.fields.timeZone")}
              </span>
              <SearchableSelect
                id="draft-timezone"
                value={draft.timeZone ?? defaultTimeZone()}
                options={timeZoneOptions}
                onValueChange={(value) => onDraftOverride({ timeZone: value })}
                disabled={isSubmitting}
                searchPlaceholder={t("edit.fields.timeZoneSearch")}
                emptyLabel={t("edit.fields.timeZoneEmpty")}
                className={FIELD_CLASS}
              />
            </label>

            <label className="block text-sm" htmlFor="draft-notifications">
              <span className="mb-2 block text-xs text-muted-foreground">
                {t("edit.fields.notifications")}
              </span>
              <Select
                value={
                  (draft.enableNotifications ?? false) ? "enabled" : "disabled"
                }
                onValueChange={(value) =>
                  onDraftOverride({ enableNotifications: value === "enabled" })
                }
                disabled={isSubmitting}
              >
                <SelectTrigger
                  id="draft-notifications"
                  className={cn("w-full", FIELD_CLASS)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled">
                    {t("details.notificationsDisabled")}
                  </SelectItem>
                  <SelectItem value="enabled">
                    {t("details.notificationsEnabled")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="block text-sm" htmlFor="draft-instructions">
              <span className="mb-2 block text-xs text-muted-foreground">
                {t("edit.fields.instructions")}
              </span>
              <Textarea
                id="draft-instructions"
                value={instructionsValue}
                onChange={(event) => {
                  const next = event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                  onDraftOverride({
                    instructions: next,
                    humanReadableInstructions: next,
                  });
                }}
                disabled={isSubmitting}
                rows={8}
                className={cn(FIELD_CLASS, "min-h-32 resize-y")}
              />
            </label>
          </div>
        )}

        {error ? (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <div className="mt-5 space-y-3">
        {draft ? (
          <Button
            type="button"
            className="w-full"
            disabled={
              isSubmitting || draftState.createRequested || draftState.created
            }
            leftIcon={<IconCheck aria-hidden="true" />}
            onClick={onApprove}
          >
            {isSubmitting
              ? isEditing
                ? t("builder.saving")
                : t("builder.processing")
              : isEditing
                ? t("builder.saveChanges")
                : t("builder.create")}
          </Button>
        ) : null}
        <div className="flex min-h-4 items-center gap-2 text-xs text-muted-foreground">
          <span>{statusText}</span>
        </div>
        {sessionId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex min-h-4 w-full min-w-0 items-center gap-2 rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => void copySessionId()}
              >
                <span className="shrink-0">
                  {copiedSessionId
                    ? t("builder.sessionIdCopied")
                    : t("builder.sessionId")}
                </span>
                <span className="truncate">{sessionId}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("builder.copySessionId")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </aside>
  );
}
