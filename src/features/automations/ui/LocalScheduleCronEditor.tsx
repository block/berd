import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconCheck, IconPencil, IconX } from "@tabler/icons-react";
import type { ScheduledJobDto } from "@aaif/goose-sdk";
import {
  LOCAL_SCHEDULES_QUERY_KEY,
  updateLocalScheduleCron,
} from "@/features/automations/api/localSchedules";
import { validateLocalScheduleCron } from "@/features/automations/lib/localScheduleCron";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

interface LocalScheduleCronEditorProps {
  schedule: ScheduledJobDto;
}

export function LocalScheduleCronEditor({
  schedule,
}: LocalScheduleCronEditorProps) {
  const { t } = useTranslation("automations");
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(schedule.cron);
  const [baselineCron, setBaselineCron] = useState(schedule.cron);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const shouldRestoreFocusOnSaveRef = useRef(false);
  const wasEditingRef = useRef(false);
  const restoreFocusAfterEditRef = useRef(false);
  const [failedCrons, setFailedCrons] = useState<Set<string>>(() => new Set());
  const normalizedCron = draft.trim().replace(/[ \t\r\n\v\f]+/g, " ");
  const validationError = validateLocalScheduleCron(draft);
  const hasChanged = draft.trim() !== baselineCron.trim();
  const hasKnownCron = draft.trim() === schedule.cron.trim();
  const sameAsFailedCron = failedCrons.has(normalizedCron);
  const updateMutation = useMutation({
    mutationFn: ({ scheduleId, cron }: { scheduleId: string; cron: string }) =>
      updateLocalScheduleCron(scheduleId, cron),
    onMutate: async () => {
      setIsSaving(true);
      setIsReconciling(false);
      await queryClient.cancelQueries({ queryKey: LOCAL_SCHEDULES_QUERY_KEY });
    },
    onSuccess: async () => {
      // Re-read the live scheduler after mutation instead of writing the
      // response into cache: a newer poll may have completed while saving.
      await queryClient.invalidateQueries({
        queryKey: LOCAL_SCHEDULES_QUERY_KEY,
      });
      setError(null);
      setFailedCrons(new Set());
      setIsSaving(false);
      setIsReconciling(false);
      restoreFocusAfterEditRef.current =
        shouldRestoreFocusOnSaveRef.current ||
        editorRef.current?.contains(document.activeElement) === true;
      setIsEditing(false);
    },
    onError: async (mutationError, variables) => {
      setError(
        formatAcpErrorMessage(mutationError, t("localSchedules.updateError")),
      );
      setFailedCrons((previous) => new Set(previous).add(variables.cron));
      setIsSaving(false);
      setIsReconciling(true);
      restoreFocusAfterEditRef.current =
        shouldRestoreFocusOnSaveRef.current ||
        editorRef.current?.contains(document.activeElement) === true ||
        document.activeElement === document.body;
      try {
        await queryClient.refetchQueries(
          {
            queryKey: LOCAL_SCHEDULES_QUERY_KEY,
            predicate: (query) => query.state.fetchStatus !== "paused",
          },
          { throwOnError: true, cancelRefetch: false },
        );
      } catch {
        setError((current) =>
          current
            ? `${current} ${t("localSchedules.refreshAfterUpdateError")}`
            : t("localSchedules.refreshAfterUpdateError"),
        );
      } finally {
        setIsReconciling(false);
      }
    },
  });

  const scheduleChangedElsewhere =
    isEditing &&
    !isReconciling &&
    !updateMutation.isError &&
    !error &&
    schedule.cron !== baselineCron;

  useLayoutEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    } else if (wasEditingRef.current && restoreFocusAfterEditRef.current) {
      editButtonRef.current?.focus();
    }
    wasEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    if (error && document.activeElement === document.body) {
      inputRef.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    if (!isEditing) {
      setDraft(schedule.cron);
      setBaselineCron(schedule.cron);
    }
  }, [isEditing, schedule.cron]);

  function beginEditing() {
    restoreFocusAfterEditRef.current = true;
    shouldRestoreFocusOnSaveRef.current = false;
    setBaselineCron(schedule.cron);
    setDraft(schedule.cron);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    shouldRestoreFocusOnSaveRef.current = false;
    setBaselineCron(schedule.cron);
    setDraft(schedule.cron);
    setError(null);
    setIsEditing(false);
  }

  function save() {
    shouldRestoreFocusOnSaveRef.current =
      editorRef.current?.contains(document.activeElement) === true;
    if (
      isReconciling ||
      !hasChanged ||
      (validationError && !hasKnownCron) ||
      sameAsFailedCron ||
      scheduleChangedElsewhere ||
      schedule.currentlyRunning
    ) {
      return;
    }
    setError(null);
    updateMutation.mutate({ scheduleId: schedule.id, cron: normalizedCron });
  }

  if (!isEditing) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("localSchedules.editCron", { id: schedule.id })}
        ref={editButtonRef}
        disabled={schedule.currentlyRunning}
        onClick={beginEditing}
      >
        <IconPencil aria-hidden="true" />
      </Button>
    );
  }

  return (
    <div ref={editorRef} className="w-full space-y-2">
      <label className="sr-only" htmlFor={`local-schedule-cron-${schedule.id}`}>
        {t("localSchedules.cronLabel", { id: schedule.id })}
      </label>
      <Input
        id={`local-schedule-cron-${schedule.id}`}
        inputRef={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        aria-invalid={!!validationError || !!error}
        aria-describedby={`local-schedule-cron-help-${schedule.id}`}
        disabled={isSaving}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <p
        id={`local-schedule-cron-help-${schedule.id}`}
        className="text-xs text-muted-foreground"
      >
        {t("localSchedules.cronHelp")}
      </p>
      {error ? (
        <div role="alert" className="text-xs text-destructive">
          <p>{error}</p>
          <p className="mt-1 text-muted-foreground">
            {t("localSchedules.updateFailureCaution")}
          </p>
        </div>
      ) : scheduleChangedElsewhere ? (
        <p role="alert" className="text-xs text-destructive">
          {t("localSchedules.changedElsewhere")}
        </p>
      ) : validationError && !hasKnownCron ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`localSchedules.validation.${validationError}`)}
        </p>
      ) : sameAsFailedCron ? (
        <p role="alert" className="text-xs text-destructive">
          {t("localSchedules.failedUpdateRetry")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={isSaving}
          onClick={cancelEditing}
        >
          <IconX aria-hidden="true" />
          {t("actions.cancel", { ns: "common" })}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={
            !hasChanged ||
            (!!validationError && !hasKnownCron) ||
            sameAsFailedCron ||
            isReconciling ||
            scheduleChangedElsewhere ||
            schedule.currentlyRunning ||
            isSaving
          }
          onClick={save}
        >
          <IconCheck aria-hidden="true" />
          {updateMutation.isPending
            ? t("localSchedules.saving")
            : t("actions.save", { ns: "common" })}
        </Button>
      </div>
    </div>
  );
}
