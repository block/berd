import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isCancelledError,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconCheck,
  IconPencil,
  IconX,
} from "@tabler/icons-react";
import type { ScheduledJobDto } from "@aaif/goose-sdk";
import {
  LOCAL_SCHEDULES_QUERY_KEY,
  listLocalSchedules,
  updateLocalScheduleCron,
} from "@/features/automations/api/localSchedules";
import { LocalScheduleRequestError } from "@/features/automations/lib/localScheduleErrors";
import { validateLocalScheduleCron } from "@/features/automations/lib/localScheduleCron";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
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
  const [failedSubmittedCron, setFailedSubmittedCron] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const wasEditingRef = useRef(false);
  const restoreFocusAfterEditRef = useRef(false);
  // Keep known timer uncertainty across panel navigation for this app session.
  // A list refresh cannot establish timer health; only a successful update can.
  const failureQueryKey = ["local-goose-schedule-failures", schedule.id];
  const { data: failedCrons } = useQuery<string[]>({
    queryKey: failureQueryKey,
    queryFn: () => [],
    enabled: false,
    initialData: [],
    gcTime: Infinity,
  });
  const mutationKey = ["local-goose-schedule-update", schedule.id];
  const isScheduleMutating = useIsMutating({ mutationKey }) > 0;
  const normalizedCron = draft.trim().replace(/[ \t\r\n\v\f]+/g, " ");
  const validationError = validateLocalScheduleCron(draft);
  const hasChanged = draft.trim() !== baselineCron.trim();
  const hasKnownCron = draft.trim() === schedule.cron.trim();
  const sameAsFailedCron = failedCrons.includes(normalizedCron);
  const errorCoversCurrentDraft = error !== null && sameAsFailedCron;

  const updateMutation = useMutation({
    mutationKey,
    mutationFn: ({ scheduleId, cron }: { scheduleId: string; cron: string }) =>
      updateLocalScheduleCron(scheduleId, cron),
    onMutate: async () => {
      setIsSaving(true);
      await queryClient.cancelQueries({ queryKey: LOCAL_SCHEDULES_QUERY_KEY });
    },
    onSuccess: () => {
      // A confirmed update establishes the new timer. Readback is independently
      // bounded in the API; its query status is visible in LocalSchedulesPanel.
      // Never retain the per-schedule mutation lock waiting for a list response.
      void queryClient.invalidateQueries({
        queryKey: LOCAL_SCHEDULES_QUERY_KEY,
      });
      setError(null);
      queryClient.setQueryData(failureQueryKey, []);
      setIsSaving(false);
      restoreFocusAfterEditRef.current =
        editorRef.current?.contains(document.activeElement) === true;
      setIsEditing(false);
    },
    onError: async (mutationError, variables) => {
      setFailedSubmittedCron(variables.cron);
      setError(
        mutationError instanceof LocalScheduleRequestError
          ? t(`localSchedules.${mutationError.code}`)
          : formatAcpErrorMessage(
              mutationError,
              t("localSchedules.updateError"),
            ),
      );
      queryClient.setQueryData<string[]>(failureQueryKey, (previous = []) => [
        ...new Set([...previous, variables.cron]),
      ]);
      setIsSaving(false);
      setIsReconciling(true);
      restoreFocusAfterEditRef.current =
        editorRef.current?.contains(document.activeElement) === true ||
        document.activeElement === document.body;

      if (mutationError instanceof LocalScheduleRequestError) {
        // This generation is retired or replaced. Release the shared save lock
        // now; even a stalled readback must not extend the mutation deadline.
        setIsReconciling(false);
        void queryClient.invalidateQueries({
          queryKey: LOCAL_SCHEDULES_QUERY_KEY,
        });
        return;
      }

      try {
        await queryClient.cancelQueries({
          queryKey: LOCAL_SCHEDULES_QUERY_KEY,
        });
        // Use the query's cancellation ordering instead of writing a detached
        // whole-list snapshot. Later updates cancel this read, including across
        // rows and remounts, so its result cannot overwrite newer schedule data.
        await queryClient.fetchQuery({
          queryKey: LOCAL_SCHEDULES_QUERY_KEY,
          queryFn: listLocalSchedules,
          staleTime: 0,
        });
      } catch (refreshError) {
        if (isCancelledError(refreshError)) return;
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
    !isSaving &&
    !isReconciling &&
    schedule.cron !== baselineCron &&
    // The rejected update may have persisted its submitted cron before failing.
    // Only that expected value can waive the original baseline mismatch.
    schedule.cron !== failedSubmittedCron;

  const displayedError = scheduleChangedElsewhere
    ? t("localSchedules.changedElsewhere")
    : error && errorCoversCurrentDraft
      ? error
      : validationError && !hasKnownCron
        ? t(`localSchedules.validation.${validationError}`)
        : isReconciling
          ? null
          : (error ??
            (sameAsFailedCron ? t("localSchedules.failedUpdateRetry") : null));
  const helpId = `local-schedule-cron-help-${schedule.id}`;
  const errorId = `local-schedule-cron-error-${schedule.id}`;
  const uncertaintyWarning =
    failedCrons.length > 0 ? (
      <Alert variant="destructive" role="status">
        <IconAlertTriangle aria-hidden="true" />
        <AlertTitle wrap>{t("localSchedules.uncertainTitle")}</AlertTitle>
        <AlertDescription>
          {t("localSchedules.updateFailureCaution")}
        </AlertDescription>
      </Alert>
    ) : null;

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
    setBaselineCron(schedule.cron);
    setDraft(schedule.cron);
    setFailedSubmittedCron(null);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setBaselineCron(schedule.cron);
    setDraft(schedule.cron);
    setError(null);
    setIsEditing(false);
  }

  function save() {
    if (
      isScheduleMutating ||
      (isReconciling && !errorCoversCurrentDraft) ||
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
      <div className={failedCrons.length > 0 ? "w-full space-y-2" : undefined}>
        {uncertaintyWarning}
        <Button
          type="button"
          variant={failedCrons.length > 0 ? "outline" : "ghost"}
          size={failedCrons.length > 0 ? "xs" : "icon-xs"}
          aria-label={t(
            failedCrons.length > 0
              ? "localSchedules.recoverCron"
              : "localSchedules.editCron",
            { id: schedule.id },
          )}
          ref={editButtonRef}
          disabled={schedule.currentlyRunning || isScheduleMutating}
          onClick={beginEditing}
        >
          <IconPencil aria-hidden="true" />
          {failedCrons.length > 0 ? t("localSchedules.recoverAction") : null}
        </Button>
      </div>
    );
  }

  return (
    <div ref={editorRef} className="w-full space-y-2">
      {uncertaintyWarning}
      <label className="sr-only" htmlFor={`local-schedule-cron-${schedule.id}`}>
        {t("localSchedules.cronLabel", { id: schedule.id })}
      </label>
      <Input
        id={`local-schedule-cron-${schedule.id}`}
        inputRef={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        aria-invalid={displayedError !== null}
        aria-describedby={displayedError ? `${helpId} ${errorId}` : helpId}
        disabled={isSaving}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <p id={helpId} className="text-xs text-muted-foreground">
        {t("localSchedules.cronHelp")}
      </p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {displayedError ? (
          <p id={errorId} className="text-xs text-destructive">
            {displayedError}
          </p>
        ) : isReconciling ? (
          <p className="text-xs text-muted-foreground">
            {t("localSchedules.reconcilingSchedule")}
          </p>
        ) : null}
      </div>
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
            (isReconciling && !errorCoversCurrentDraft) ||
            scheduleChangedElsewhere ||
            schedule.currentlyRunning ||
            isScheduleMutating ||
            isSaving
          }
          onClick={save}
        >
          <IconCheck aria-hidden="true" />
          {isSaving
            ? t("localSchedules.saving")
            : t("actions.save", { ns: "common" })}
        </Button>
      </div>
    </div>
  );
}
