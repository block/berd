import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCopy, IconPencil, IconTrash } from "@tabler/icons-react";
import { PinIcon } from "lucide-react";
import type {
  AutomationTile,
  UpdateAutomationTileRequest,
} from "@/features/automations/api/kgooseAutomations";
import {
  automationTimeZone,
  buildScheduleFromForm,
  defaultTimeZone,
  instructionsToText,
  parseScheduleForm,
  supportedTimeZones,
  textToInstructions,
  type SchedulePreset,
} from "@/features/automations/lib/automationFormatting";
import { AutomationHistory } from "@/features/automations/ui/AutomationHistory";
import { AutomationLatestResultCard } from "@/features/automations/ui/AutomationLatestResultCard";
import { EmptyState } from "@/features/automations/ui/RunOutput";
import { Button } from "@/shared/ui/button";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Textarea } from "@/shared/ui/textarea";

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
const ACTION_BUTTON_CLASS =
  "size-9 rounded-full bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover hover:text-surface-agent-profile-fg";
const PRIMARY_ACTION_BUTTON_CLASS =
  "size-9 rounded-full !bg-surface-agent-profile-fg !text-surface-agent-profile-control-bg hover:!bg-surface-agent-profile-action-bg-hover";
const ACTION_ICON_CLASS = "size-3.5";

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

export function AutomationDetailPage({
  tile,
  activeTab,
  selectedRunKey,
  mutationError,
  isSaving,
  actions,
  onActiveTabChange,
  onSelectRun,
  onSave,
}: {
  tile: AutomationTile;
  activeTab: "details" | "history";
  selectedRunKey: string | null;
  mutationError: string | null;
  isSaving: boolean;
  actions?: {
    pinLabel: string;
    isPinned: boolean;
    isPinning: boolean;
    onTogglePin: () => void;
    onEditWithChat: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    canEditWithChat: boolean;
    canDuplicate: boolean;
    isDuplicating: boolean;
    isDeleting: boolean;
  };
  onActiveTabChange: (tab: "details" | "history") => void;
  onSelectRun: (runKey: string | null) => void;
  onSave: (request: UpdateAutomationTileRequest) => void;
}) {
  const { t } = useTranslation("automations");
  const initialSchedule = parseScheduleForm(tile.schedule);
  const [titleDraft, setTitleDraft] = useState(tile.title ?? "");
  const [instructionsDraft, setInstructionsDraft] = useState(
    instructionsToText(tile),
  );
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [instructionsSaveState, setInstructionsSaveState] = useState<
    "idle" | "requested" | "saving" | "savedPendingRefresh"
  >("idle");
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>(
    initialSchedule.preset,
  );
  const [scheduleTime, setScheduleTime] = useState(initialSchedule.time);
  const [scheduleWeekday, setScheduleWeekday] = useState(
    initialSchedule.weekday,
  );
  const [customSchedule, setCustomSchedule] = useState(
    initialSchedule.customSchedule,
  );
  const [timeZoneDraft, setTimeZoneDraft] = useState(automationTimeZone(tile));
  const [notificationsDraft, setNotificationsDraft] = useState(
    tile.enableNotifications ?? false,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [previousTile, setPreviousTile] = useState(tile);
  const instructionsDraftRef = useRef(instructionsDraft);
  if (previousTile !== tile) {
    const nextSchedule = parseScheduleForm(tile.schedule);
    const nextInstructions = instructionsToText(tile);
    const tileIdChanged = previousTile.id !== tile.id;

    setPreviousTile(tile);
    setTitleDraft(tile.title ?? "");
    if (
      tileIdChanged ||
      (!isEditingInstructions && instructionsSaveState === "idle") ||
      (instructionsSaveState === "savedPendingRefresh" &&
        nextInstructions.trim() === instructionsDraftRef.current.trim())
    ) {
      setInstructionsDraft(nextInstructions);
    }
    if (tileIdChanged) {
      setIsEditingInstructions(false);
      setInstructionsSaveState("idle");
    }
    setSchedulePreset(nextSchedule.preset);
    setScheduleTime(nextSchedule.time);
    setScheduleWeekday(nextSchedule.weekday);
    setCustomSchedule(nextSchedule.customSchedule);
    setTimeZoneDraft(automationTimeZone(tile));
    setNotificationsDraft(tile.enableNotifications ?? false);
    setLocalError(null);
  }
  const timeZoneOptions = useMemo(
    () =>
      [
        ...new Set([
          automationTimeZone(tile),
          defaultTimeZone(),
          ...supportedTimeZones(),
        ]),
      ]
        .sort((a, b) => a.localeCompare(b))
        .map((timeZone) => ({ value: timeZone, label: timeZone })),
    [tile],
  );
  const timeOptions = useMemo(() => {
    if (
      !scheduleTime ||
      TIME_SLOT_OPTIONS.some((option) => option.value === scheduleTime)
    ) {
      return TIME_SLOT_OPTIONS;
    }
    return [
      { value: scheduleTime, label: formatTimeLabel(scheduleTime) },
      ...TIME_SLOT_OPTIONS,
    ];
  }, [scheduleTime]);
  useEffect(() => {
    instructionsDraftRef.current = instructionsDraft;
  }, [instructionsDraft]);

  if (instructionsSaveState === "requested" && isSaving) {
    setInstructionsSaveState("saving");
  } else if (instructionsSaveState === "saving" && !isSaving) {
    if (mutationError) {
      setInstructionsSaveState("idle");
    } else {
      setInstructionsSaveState("savedPendingRefresh");
      setIsEditingInstructions(false);
    }
  }

  const baseUpdateRequest = (): UpdateAutomationTileRequest | null => {
    if (!tile.id) return null;
    return { id: tile.id };
  };

  const saveTitle = () => {
    const request = baseUpdateRequest();
    if (!request) return;
    const trimmedTitle = titleDraft.trim();
    if (!trimmedTitle || trimmedTitle === (tile.title ?? "")) return;
    setLocalError(null);
    onSave({ ...request, title: trimmedTitle });
  };

  const saveInstructions = () => {
    const request = baseUpdateRequest();
    if (!request) return;
    const nextInstructions = textToInstructions(instructionsDraft);
    const originalInstructions = instructionsToText(tile).trim();
    if (instructionsDraft.trim() === originalInstructions) return;
    if (!nextInstructions.length) {
      setLocalError(t("edit.instructionsRequired"));
      return;
    }
    setLocalError(null);
    setInstructionsSaveState("requested");
    onSave({
      ...request,
      updateInstructions: true,
      instructions: nextInstructions,
    });
  };

  const startEditingInstructions = () => {
    setInstructionsDraft(instructionsToText(tile));
    setInstructionsSaveState("idle");
    setLocalError(null);
    setIsEditingInstructions(true);
  };

  const cancelEditingInstructions = () => {
    setInstructionsDraft(instructionsToText(tile));
    setInstructionsSaveState("idle");
    setLocalError(null);
    setIsEditingInstructions(false);
  };

  const saveSchedule = (next: {
    preset?: SchedulePreset;
    time?: string;
    weekday?: string;
    customSchedule?: string;
  }) => {
    const request = baseUpdateRequest();
    if (!request) return;
    const nextState = {
      preset: next.preset ?? schedulePreset,
      time: next.time ?? scheduleTime,
      weekday: next.weekday ?? scheduleWeekday,
      customSchedule: next.customSchedule ?? customSchedule,
    };
    const nextSchedule = buildScheduleFromForm(nextState);
    if (nextSchedule === (tile.schedule ?? "")) return;
    const nextTimeZone = timeZoneDraft.trim() || automationTimeZone(tile);
    setLocalError(null);
    request.updateSchedule = true;
    request.schedule = nextSchedule;
    if (nextSchedule || nextTimeZone !== (tile.timeZone ?? "")) {
      request.timeZone = nextTimeZone;
    }
    onSave(request);
  };

  const saveTimeZone = (nextTimeZone = timeZoneDraft) => {
    setTimeZoneDraft(nextTimeZone);
    const request = baseUpdateRequest();
    if (!request) return;
    const trimmedTimeZone = nextTimeZone.trim();
    if (!trimmedTimeZone || trimmedTimeZone === (tile.timeZone ?? "")) return;
    const currentSchedule = buildScheduleFromForm({
      preset: schedulePreset,
      time: scheduleTime,
      weekday: scheduleWeekday,
      customSchedule,
    });
    setLocalError(null);
    const updateRequest: UpdateAutomationTileRequest = {
      id: request.id,
      updateSchedule: true,
      timeZone: trimmedTimeZone,
    };
    if (currentSchedule) {
      updateRequest.schedule = currentSchedule;
    }
    onSave(updateRequest);
  };

  const saveNotifications = (enabled: boolean) => {
    setNotificationsDraft(enabled);
    if (!tile.id || enabled === (tile.enableNotifications ?? false)) return;
    const request = baseUpdateRequest();
    if (!request) return;
    setLocalError(null);
    onSave({ ...request, enableNotifications: enabled });
  };

  const currentError = localError ?? mutationError;
  const instructionsText = instructionsDraft.trim();
  const instructionsChanged =
    instructionsDraft.trim() !== instructionsToText(tile).trim();
  const isSavingInstructions =
    instructionsSaveState === "requested" || instructionsSaveState === "saving";

  return (
    <section className="min-w-0 space-y-8">
      {currentError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {currentError}
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          onActiveTabChange(value as "details" | "history")
        }
      >
        <TabsList variant="weight">
          <TabsTrigger value="details" variant="weight">
            {t("tabs.details")}
          </TabsTrigger>
          <TabsTrigger value="history" variant="weight">
            {t("tabs.history")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <div className="grid min-h-0 gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
            <aside className="space-y-6">
              <section className="space-y-6">
                <label className="block text-sm" htmlFor="detail-name">
                  <span className="mb-2 block text-xs text-muted-foreground">
                    {t("edit.fields.title")}
                  </span>
                  <Input
                    id="detail-name"
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    disabled={isSaving}
                    className={FIELD_CLASS}
                  />
                </label>

                <label
                  className="block text-sm"
                  htmlFor="detail-schedule-preset"
                >
                  <span className="mb-2 block text-xs text-muted-foreground">
                    {t("edit.fields.scheduleRepeats")}
                  </span>
                  <Select
                    value={schedulePreset}
                    onValueChange={(value) => {
                      const nextPreset = value as SchedulePreset;
                      setSchedulePreset(nextPreset);
                      saveSchedule({ preset: nextPreset });
                    }}
                    disabled={isSaving}
                  >
                    <SelectTrigger
                      id="detail-schedule-preset"
                      className="w-full rounded-sm border-transparent bg-card"
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

                {schedulePreset === "weekly" ? (
                  <label
                    className="block text-sm"
                    htmlFor="detail-schedule-day"
                  >
                    <span className="mb-2 block text-xs text-muted-foreground">
                      {t("edit.fields.scheduleDay")}
                    </span>
                    <Select
                      value={scheduleWeekday}
                      onValueChange={(value) => {
                        setScheduleWeekday(value);
                        saveSchedule({ weekday: value });
                      }}
                      disabled={isSaving}
                    >
                      <SelectTrigger
                        id="detail-schedule-day"
                        className="w-full rounded-sm border-transparent bg-card"
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

                {schedulePreset !== "none" &&
                schedulePreset !== "hourly" &&
                schedulePreset !== "custom" ? (
                  <label
                    className="block text-sm"
                    htmlFor="detail-schedule-time"
                  >
                    <span className="mb-2 block text-xs text-muted-foreground">
                      {t("edit.fields.scheduleTime")}
                    </span>
                    <Select
                      value={scheduleTime}
                      onValueChange={(value) => {
                        setScheduleTime(value);
                        saveSchedule({ time: value });
                      }}
                      disabled={isSaving}
                    >
                      <SelectTrigger
                        id="detail-schedule-time"
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

                {schedulePreset === "custom" ? (
                  <label
                    className="block text-sm"
                    htmlFor="detail-schedule-custom"
                  >
                    <span className="mb-2 block text-xs text-muted-foreground">
                      {t("edit.fields.scheduleCustom")}
                    </span>
                    <Input
                      id="detail-schedule-custom"
                      value={customSchedule}
                      onChange={(event) =>
                        setCustomSchedule(event.target.value)
                      }
                      onBlur={() => saveSchedule({ customSchedule })}
                      placeholder={t("edit.fields.schedulePlaceholder")}
                      disabled={isSaving}
                      className="rounded-sm border-transparent bg-card"
                    />
                  </label>
                ) : null}

                <label className="block text-sm" htmlFor="detail-timezone">
                  <span className="mb-2 block text-xs text-muted-foreground">
                    {t("details.timeZone")}
                  </span>
                  <SearchableSelect
                    id="detail-timezone"
                    value={timeZoneDraft}
                    options={timeZoneOptions}
                    onValueChange={saveTimeZone}
                    disabled={isSaving}
                    searchPlaceholder={t("edit.fields.timeZoneSearch")}
                    emptyLabel={t("edit.fields.timeZoneEmpty")}
                    className="rounded-sm border-transparent bg-card"
                  />
                </label>

                <label className="block text-sm" htmlFor="detail-notifications">
                  <span className="mb-2 block text-xs text-muted-foreground">
                    {t("edit.fields.notifications")}
                  </span>
                  <Select
                    value={notificationsDraft ? "enabled" : "disabled"}
                    onValueChange={(value) =>
                      saveNotifications(value === "enabled")
                    }
                    disabled={isSaving}
                  >
                    <SelectTrigger
                      id="detail-notifications"
                      className={cn("w-full", FIELD_CLASS)}
                      aria-label={t("details.notifications")}
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

                {actions ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t("actions.editWithChat")}
                      tooltip={t("actions.editWithChat")}
                      onClick={actions.onEditWithChat}
                      disabled={!actions.canEditWithChat}
                      className={PRIMARY_ACTION_BUTTON_CLASS}
                    >
                      <IconPencil className={ACTION_ICON_CLASS} />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={actions.pinLabel}
                      tooltip={actions.pinLabel}
                      onClick={actions.onTogglePin}
                      disabled={actions.isPinning || !tile.id}
                      className={ACTION_BUTTON_CLASS}
                    >
                      <PinIcon
                        className={ACTION_ICON_CLASS}
                        fill={actions.isPinned ? "currentColor" : "none"}
                      />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={
                        actions.isDuplicating
                          ? t("actions.duplicating")
                          : t("actions.duplicate")
                      }
                      tooltip={
                        actions.isDuplicating
                          ? t("actions.duplicating")
                          : t("actions.duplicate")
                      }
                      onClick={actions.onDuplicate}
                      disabled={actions.isDuplicating || !actions.canDuplicate}
                      className={ACTION_BUTTON_CLASS}
                    >
                      <IconCopy className={ACTION_ICON_CLASS} />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t("actions.delete")}
                      tooltip={t("actions.delete")}
                      onClick={actions.onDelete}
                      disabled={actions.isDeleting}
                      className={ACTION_BUTTON_CLASS}
                    >
                      <IconTrash className={ACTION_ICON_CLASS} />
                    </Button>
                  </div>
                ) : null}
              </section>
            </aside>

            <div className="min-w-0 space-y-4">
              <AutomationLatestResultCard tile={tile} />

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xs leading-4 font-medium text-muted-foreground">
                    {t("details.instructions")}
                  </h2>
                  {isEditingInstructions ? (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={cancelEditingInstructions}
                        disabled={isSavingInstructions}
                      >
                        {t("actions.cancel")}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        onClick={saveInstructions}
                        disabled={
                          isSavingInstructions ||
                          !instructionsChanged ||
                          !textToInstructions(instructionsDraft).length
                        }
                      >
                        {isSavingInstructions
                          ? t("actions.saving")
                          : t("actions.saveChanges")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={startEditingInstructions}
                      disabled={isSaving}
                      aria-label={t("details.editInstructions")}
                      leftIcon={<IconPencil aria-hidden="true" />}
                    >
                      {t("actions.edit")}
                    </Button>
                  )}
                </div>
                <section className="rounded-md bg-card p-4">
                  {isEditingInstructions ? (
                    <Textarea
                      aria-label={t("edit.fields.instructions")}
                      value={instructionsDraft}
                      onChange={(event) =>
                        setInstructionsDraft(event.target.value)
                      }
                      disabled={isSavingInstructions}
                      placeholder={t("details.noInstructions")}
                      rows={12}
                      className="min-h-[360px] resize-y rounded-sm text-[14px] leading-relaxed"
                    />
                  ) : instructionsText ? (
                    <div className="min-h-40 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {instructionsText}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {t("details.noInstructions")}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          {tile.id ? (
            <AutomationHistory
              tile={tile}
              tileId={tile.id}
              selectedRunKey={selectedRunKey}
              onSelectRun={onSelectRun}
            />
          ) : (
            <EmptyState
              title={t("history.unavailableTitle")}
              body={t("history.unavailableBody")}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
