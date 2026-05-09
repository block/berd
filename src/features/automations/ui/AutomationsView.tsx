import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconPlus,
  IconPencil,
  IconPlayerPause,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  type AutomationTile,
  type AutomationTileResult,
  type UpdateAutomationTileRequest,
  deleteAutomationTile,
  generateAutomationSchedule,
  getAutomationSessionMessages,
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
  updateAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { AutomationBuilderPanel } from "@/features/automations/ui/AutomationBuilderPanel";
import { getStableInstructionItems } from "@/features/automations/lib/stableInstructionItems";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { Separator } from "@/shared/ui/separator";
import { Spinner } from "@/shared/ui/spinner";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Textarea } from "@/shared/ui/textarea";
import { cn } from "@/shared/lib/cn";

const AUTOMATIONS_REFETCH_INTERVAL_MS = 15_000;

function formatStatus(
  value: string | number | undefined,
  unknownLabel: string,
) {
  if (value === undefined || value === null) {
    return unknownLabel;
  }

  return String(value)
    .replace(/^TILE_RUN_STATUS_/, "")
    .replace(/^TILE_STATUS_/, "")
    .replace(/^TILE_TYPE_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusVariant(
  value: string | number | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("failed")) return "destructive";
  if (normalized.includes("inactive")) return "outline";
  if (normalized.includes("success") || normalized.includes("active")) {
    return "default";
  }
  if (normalized.includes("running") || normalized.includes("pending")) {
    return "secondary";
  }
  return "outline";
}

function statusIcon(value: string | number | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("failed")) return <IconX aria-hidden="true" />;
  if (normalized.includes("success") || normalized.includes("active")) {
    return <IconCheck aria-hidden="true" />;
  }
  if (normalized.includes("running") || normalized.includes("pending")) {
    return <IconClock aria-hidden="true" />;
  }
  return undefined;
}

function formatTimestamp(value: string | undefined, neverLabel: string) {
  if (!value || value === "0") {
    return neverLabel;
  }

  const numericValue = Number(value);
  const date = Number.isFinite(numericValue)
    ? new Date(numericValue)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatSchedule(
  tile: AutomationTile,
  labels: {
    noSchedule: string;
    paused: string;
    pausedWithReason: (reason: string) => string;
  },
) {
  if (tile.schedulePaused) {
    return tile.pausedReason
      ? labels.pausedWithReason(tile.pausedReason)
      : labels.paused;
  }
  return tile.schedule || labels.noSchedule;
}

function automationTitle(tile: AutomationTile, untitledLabel: string) {
  return tile.title?.trim() || untitledLabel;
}

function getRunKey(result: AutomationTileResult, index: number) {
  return [
    result.tileResultTimestamp,
    result.created,
    result.updated,
    result.sessionId,
    result.runStatus,
    index,
  ]
    .map((value) => (value == null ? "" : String(value)))
    .join("|");
}

function getOutputSummary(data: Record<string, unknown> | undefined) {
  if (!data) return null;
  const summary = data.summary;
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }
  const text = data.text ?? data.markdown ?? data.output;
  if (typeof text === "string" && text.trim()) {
    return text;
  }
  return null;
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function AutomationListItem({
  tile,
  selected,
  onSelect,
}: {
  tile: AutomationTile;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("automations");
  const scheduleLabels = {
    noSchedule: t("schedule.none"),
    paused: t("schedule.paused"),
    pausedWithReason: (reason: string) =>
      t("schedule.pausedWithReason", { reason }),
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[1fr_auto] gap-3 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-brand bg-brand/5"
          : "border-border bg-background hover:bg-muted/40",
      )}
      aria-pressed={selected}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {automationTitle(tile, t("fallbacks.untitledAutomation"))}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {formatSchedule(tile, scheduleLabels)}
        </span>
      </span>
      <span className="flex flex-col items-end gap-2">
        <Badge variant={statusVariant(tile.latestRunStatus)}>
          {statusIcon(tile.latestRunStatus)}
          {formatStatus(tile.latestRunStatus, t("fallbacks.unknown"))}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {formatTimestamp(tile.lastSuccessAt, t("fallbacks.never"))}
        </span>
      </span>
    </button>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function AutomationDetails({ tile }: { tile: AutomationTile }) {
  const { t } = useTranslation("automations");
  const scheduleLabels = {
    noSchedule: t("schedule.none"),
    paused: t("schedule.paused"),
    pausedWithReason: (reason: string) =>
      t("schedule.pausedWithReason", { reason }),
  };
  const instructions = tile.humanReadableInstructions?.length
    ? tile.humanReadableInstructions
    : tile.instructions;
  const instructionItems = instructions
    ? getStableInstructionItems(instructions)
    : [];
  const latestOutputSummary = tile.latestRenderedData
    ? getOutputSummary(tile.latestRenderedData)
    : null;

  return (
    <div className="space-y-6">
      <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DetailField
          label={t("details.schedule")}
          value={formatSchedule(tile, scheduleLabels)}
        />
        <DetailField
          label={t("details.timeZone")}
          value={tile.timeZone || t("fallbacks.notSet")}
        />
        <DetailField
          label={t("details.lastSuccessfulRun")}
          value={formatTimestamp(tile.lastSuccessAt, t("fallbacks.never"))}
        />
        <DetailField
          label={t("details.status")}
          value={formatStatus(tile.status, t("fallbacks.unknown"))}
        />
        <DetailField
          label={t("details.latestRun")}
          value={formatStatus(tile.latestRunStatus, t("fallbacks.unknown"))}
        />
        <DetailField
          label={t("details.notifications")}
          value={
            tile.enableNotifications
              ? t("details.notificationsEnabled")
              : t("details.notificationsDisabled")
          }
        />
      </dl>

      <Separator />

      <section>
        <h3 className="text-sm font-medium text-foreground">
          {t("details.instructions")}
        </h3>
        {instructionItems.length ? (
          <ol className="mt-3 space-y-2">
            {instructionItems.map(({ instruction, key }) => (
              <li
                key={key}
                className="rounded-lg border border-border bg-background p-3 text-sm text-foreground"
              >
                {instruction}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("details.noInstructions")}
          </p>
        )}
      </section>

      {(tile.requiredConnections?.length ||
        tile.subscribedLabels?.length ||
        tile.toolCallNames?.length) && (
        <>
          <Separator />
          <section className="grid gap-4 md:grid-cols-3">
            <TagGroup
              title={t("details.connections")}
              values={tile.requiredConnections}
            />
            <TagGroup
              title={t("details.subscribedLabels")}
              values={tile.subscribedLabels}
            />
            <TagGroup title={t("details.tools")} values={tile.toolCallNames} />
          </section>
        </>
      )}

      {tile.latestRenderedData && (
        <>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">
              {t("details.latestOutput")}
            </h3>
            {latestOutputSummary ? (
              <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
                {latestOutputSummary}
              </p>
            ) : (
              <JsonPreview value={tile.latestRenderedData} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function instructionsToText(tile: AutomationTile) {
  return (tile.instructions ?? tile.humanReadableInstructions ?? []).join("\n");
}

function textToInstructions(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultTimeZone() {
  return typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
}

function automationTimeZone(tile: AutomationTile) {
  return tile.timeZone ?? defaultTimeZone();
}

function AutomationEditForm({
  tile,
  onCancel,
  onSave,
  isSaving,
  saveError,
}: {
  tile: AutomationTile;
  onCancel: () => void;
  onSave: (request: UpdateAutomationTileRequest) => void;
  isSaving: boolean;
  saveError: string | null;
}) {
  const { t } = useTranslation("automations");
  const [title, setTitle] = useState(tile.title ?? "");
  const [schedule, setSchedule] = useState(tile.schedule ?? "");
  const [timeZone, setTimeZone] = useState(automationTimeZone(tile));
  const [instructions, setInstructions] = useState(instructionsToText(tile));
  const [enableNotifications, setEnableNotifications] = useState(
    tile.enableNotifications ?? false,
  );
  const [formError, setFormError] = useState<string | null>(null);

  const scheduleMutation = useMutation({
    mutationFn: () => generateAutomationSchedule(schedule, timeZone),
    onSuccess: (response) => {
      if (response.success === false) {
        setFormError(response.errorMsg ?? t("edit.generateError"));
        return;
      }
      if (!response.cronExpression) {
        setFormError(t("edit.generateError"));
        return;
      }
      setSchedule(response.cronExpression);
      setFormError(null);
    },
    onError: (error) => {
      setFormError(
        error instanceof Error ? error.message : t("edit.generateError"),
      );
    },
  });

  useEffect(() => {
    setTitle(tile.title ?? "");
    setSchedule(tile.schedule ?? "");
    setTimeZone(automationTimeZone(tile));
    setInstructions(instructionsToText(tile));
    setEnableNotifications(tile.enableNotifications ?? false);
    setFormError(null);
  }, [tile]);

  const handleSave = () => {
    if (!tile.id) return;

    const nextInstructions = textToInstructions(instructions);
    const trimmedTitle = title.trim();
    const trimmedSchedule = schedule.trim();
    const trimmedTimeZone = timeZone.trim();
    const originalInstructions = instructionsToText(tile).trim();
    const scheduleChanged = trimmedSchedule !== (tile.schedule ?? "");
    const timeZoneChanged =
      Boolean(trimmedTimeZone) && trimmedTimeZone !== (tile.timeZone ?? "");
    const request: UpdateAutomationTileRequest = { id: tile.id };

    if (trimmedTitle !== (tile.title ?? "")) {
      request.title = trimmedTitle;
    }

    if (scheduleChanged || timeZoneChanged) {
      request.updateSchedule = true;
      if (trimmedSchedule) {
        request.schedule = trimmedSchedule;
      }
      if (timeZoneChanged) {
        request.timeZone = trimmedTimeZone;
      }
    }

    if (instructions.trim() !== originalInstructions) {
      if (!nextInstructions.length) {
        setFormError(t("edit.instructionsRequired"));
        return;
      }
      request.updateInstructions = true;
      request.instructions = nextInstructions;
    }

    if (enableNotifications !== (tile.enableNotifications ?? false)) {
      request.enableNotifications = enableNotifications;
    }

    if (Object.keys(request).length === 1) {
      onCancel();
      return;
    }

    setFormError(null);
    onSave(request);
  };

  const currentError = formError ?? saveError;

  return (
    <section className="space-y-5 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("edit.title")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("edit.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSaving}
          >
            {t("actions.cancel")}
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      </div>

      {currentError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {currentError}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm" htmlFor="automation-title">
          <span className="font-medium text-foreground">
            {t("edit.fields.title")}
          </span>
          <Input
            id="automation-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={isSaving}
          />
        </label>
        <label className="grid gap-2 text-sm" htmlFor="automation-timezone">
          <span className="font-medium text-foreground">
            {t("edit.fields.timeZone")}
          </span>
          <Input
            id="automation-timezone"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            disabled={isSaving}
          />
        </label>
      </div>

      <label className="grid gap-2 text-sm" htmlFor="automation-schedule">
        <span className="font-medium text-foreground">
          {t("edit.fields.schedule")}
        </span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="automation-schedule"
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            placeholder={t("edit.fields.schedulePlaceholder")}
            disabled={isSaving}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => scheduleMutation.mutate()}
            disabled={
              isSaving || scheduleMutation.isPending || !schedule.trim()
            }
          >
            {scheduleMutation.isPending
              ? t("actions.generating")
              : t("actions.generateCron")}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("edit.fields.scheduleHelp")}
        </span>
      </label>

      <label className="grid gap-2 text-sm" htmlFor="automation-instructions">
        <span className="font-medium text-foreground">
          {t("edit.fields.instructions")}
        </span>
        <Textarea
          id="automation-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          className="min-h-36"
          disabled={isSaving}
        />
      </label>

      <label
        className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
        htmlFor="automation-notifications"
      >
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t("edit.fields.notifications")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("edit.fields.notificationsHelp")}
          </span>
        </span>
        <Switch
          id="automation-notifications"
          checked={enableNotifications}
          onCheckedChange={setEnableNotifications}
          disabled={isSaving}
          aria-label={t("edit.fields.notifications")}
        />
      </label>
    </section>
  );
}

function TagGroup({
  title,
  values,
}: {
  title: string;
  values: string[] | undefined;
}) {
  const { t } = useTranslation("automations");

  return (
    <div>
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      {values?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary">
              {value}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("fallbacks.none")}
        </p>
      )}
    </div>
  );
}

function AutomationHistory({
  tileId,
  selectedRunKey,
  onSelectRun,
}: {
  tileId: string;
  selectedRunKey: string | null;
  onSelectRun: (runKey: string) => void;
}) {
  const { t } = useTranslation("automations");
  const historyQuery = useQuery({
    queryKey: ["automationTileResults", tileId],
    queryFn: () => getAutomationTileResults(tileId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  if (historyQuery.isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner className="size-5 text-brand" />
      </div>
    );
  }

  if (historyQuery.error) {
    return (
      <EmptyState
        title={t("history.loadErrorTitle")}
        body={historyQuery.error.message}
      />
    );
  }

  const results = [...(historyQuery.data?.tilesResults ?? [])].sort(
    (a, b) => Number(b.created ?? 0) - Number(a.created ?? 0),
  );

  if (!results.length) {
    return (
      <EmptyState
        title={t("history.emptyTitle")}
        body={t("history.emptyBody")}
      />
    );
  }

  const keyedResults = results.map((result, index) => ({
    result,
    runKey: getRunKey(result, index),
  }));
  const selectedRun =
    keyedResults.find((item) => item.runKey === selectedRunKey) ??
    keyedResults[0];

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(260px,360px)_1fr]">
      <div className="space-y-2">
        {keyedResults.map(({ result, runKey }) => (
          <HistoryItem
            key={runKey}
            result={result}
            selected={runKey === selectedRun.runKey}
            onSelect={() => onSelectRun(runKey)}
          />
        ))}
      </div>
      <RunOutput result={selectedRun.result} />
    </div>
  );
}

function HistoryItem({
  result,
  selected,
  onSelect,
}: {
  result: AutomationTileResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("automations");

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full gap-2 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-brand bg-brand/5"
          : "border-border bg-background hover:bg-muted/40",
      )}
      aria-pressed={selected}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="truncate text-sm text-foreground">
          {formatTimestamp(result.created, t("fallbacks.never"))}
        </span>
        <Badge variant={statusVariant(result.runStatus)}>
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </Badge>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {result.sessionId || t("history.noSessionId")}
      </span>
    </button>
  );
}

function RunOutput({ result }: { result: AutomationTileResult }) {
  const { t } = useTranslation("automations");
  const summary = getOutputSummary(result.tileData);
  const sessionQuery = useQuery({
    queryKey: ["automationSessionMessages", result.sessionId],
    queryFn: () => getAutomationSessionMessages(result.sessionId ?? ""),
    enabled: Boolean(result.sessionId),
  });
  const messages = sessionQuery.data?.messages ?? [];

  return (
    <section className="min-w-0 space-y-5 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("history.sessionHistory")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.sessionId ?? t("history.noSessionId")}
          </p>
        </div>
        <Badge variant={statusVariant(result.runStatus)}>
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </Badge>
      </div>

      {(summary || result.tileData) && (
        <>
          <Separator />
          <section className="space-y-3">
            <h4 className="text-sm font-medium text-foreground">
              {t("history.runOutput")}
            </h4>
            {summary ? (
              <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm leading-relaxed text-foreground">
                {summary}
              </p>
            ) : (
              <JsonPreview value={result.tileData} />
            )}
          </section>
        </>
      )}

      <Separator />

      {!result.sessionId ? (
        <p className="text-sm text-muted-foreground">
          {t("history.sessionUnavailable")}
        </p>
      ) : sessionQuery.isLoading ? (
        <div className="flex min-h-32 items-center justify-center">
          <Spinner className="size-5 text-brand" />
        </div>
      ) : sessionQuery.error ? (
        <EmptyState
          title={t("history.sessionLoadErrorTitle")}
          body={sessionQuery.error.message}
        />
      ) : messages.length ? (
        <div className="h-[34rem] overflow-hidden rounded-lg border border-border bg-background">
          <MessageTimeline messages={messages} className="h-full" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("history.noSessionMessages")}
        </p>
      )}
    </section>
  );
}

export function AutomationsView() {
  const { t } = useTranslation("automations");
  const queryClient = useQueryClient();
  const [selectedAutomationId, setSelectedAutomationId] = useState<
    string | null
  >(null);
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [pendingCreatedAutomationId, setPendingCreatedAutomationId] = useState<
    string | null
  >(null);
  const delayedRefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(
    null,
  );
  const [deleteAutomationId, setDeleteAutomationId] = useState<string | null>(
    null,
  );
  const [mutationError, setMutationError] = useState<string | null>(null);
  const scheduleLabels = {
    noSchedule: t("schedule.none"),
    paused: t("schedule.paused"),
    pausedWithReason: (reason: string) =>
      t("schedule.pausedWithReason", { reason }),
  };

  const automationsQuery = useQuery({
    queryKey: ["automationTiles"],
    queryFn: getAutomationTiles,
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const automations = useMemo(
    () => automationsQuery.data?.tiles ?? [],
    [automationsQuery.data?.tiles],
  );

  useEffect(() => {
    if (!automations.length) {
      setSelectedAutomationId(null);
      setSelectedRunKey(null);
      return;
    }
    if (
      selectedAutomationId &&
      automations.some((tile) => tile.id === selectedAutomationId)
    ) {
      if (selectedAutomationId === pendingCreatedAutomationId) {
        setPendingCreatedAutomationId(null);
      }
      return;
    }
    if (
      selectedAutomationId &&
      selectedAutomationId === pendingCreatedAutomationId
    ) {
      return;
    }
    setSelectedAutomationId(automations[0]?.id ?? null);
    setSelectedRunKey(null);
  }, [automations, pendingCreatedAutomationId, selectedAutomationId]);

  const selectedAutomation = automations.find(
    (tile) => tile.id === selectedAutomationId,
  );
  const deleteAutomation = automations.find(
    (tile) => tile.id === deleteAutomationId,
  );

  const detailQuery = useQuery({
    queryKey: ["automationTile", selectedAutomationId],
    queryFn: () => getAutomationTile(selectedAutomationId ?? ""),
    enabled: Boolean(selectedAutomationId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const detailTile = detailQuery.data?.tileInfo ?? selectedAutomation;
  const detailTileId = detailTile?.id;
  const isEditing = Boolean(
    detailTileId && detailTileId === editingAutomationId,
  );
  const deleteAutomationName = deleteAutomation
    ? automationTitle(deleteAutomation, t("fallbacks.untitledAutomation"))
    : t("fallbacks.untitledAutomation");

  const invalidateAutomationQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["automationTiles"] }),
      queryClient.invalidateQueries({ queryKey: ["automationTile"] }),
      queryClient.invalidateQueries({ queryKey: ["automationTileResults"] }),
    ]);
  };

  const updateMutation = useMutation({
    mutationFn: updateAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("edit.saveError"));
        return;
      }
      setMutationError(null);
      setEditingAutomationId(null);
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : t("edit.saveError"),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("delete.error"));
        return;
      }
      const nextAutomation = automations.find(
        (tile) => tile.id && tile.id !== deleteAutomationId,
      );
      setMutationError(null);
      setDeleteAutomationId(null);
      setEditingAutomationId(null);
      setSelectedAutomationId(nextAutomation?.id ?? null);
      setSelectedRunKey(null);
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : t("delete.error"),
      );
    },
  });

  useEffect(() => {
    return () => {
      if (delayedRefetchTimeoutRef.current) {
        clearTimeout(delayedRefetchTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="h-full overflow-hidden bg-background">
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[360px_1fr]">
        <aside
          className="min-h-0 border-b border-border lg:border-r lg:border-b-0"
          aria-label={t("list.ariaLabel")}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div className="min-w-0">
                <h1 className="text-xl font-medium text-foreground">
                  {t("title")}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("subtitle")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBuilderOpen(true)}
                  aria-label={t("actions.add")}
                  title={t("actions.add")}
                  leftIcon={<IconPlus aria-hidden="true" />}
                >
                  {t("actions.addShort")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => automationsQuery.refetch()}
                  aria-label={t("actions.refresh")}
                  title={t("actions.refresh")}
                  leftIcon={<IconRefresh aria-hidden="true" />}
                >
                  {t("actions.refreshShort")}
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {automationsQuery.isLoading ? (
                <div className="flex min-h-48 items-center justify-center">
                  <Spinner className="size-5 text-brand" />
                </div>
              ) : automationsQuery.error ? (
                <EmptyState
                  title={t("list.loadErrorTitle")}
                  body={automationsQuery.error.message}
                />
              ) : automations.length ? (
                <div className="space-y-2">
                  {automations.map((tile) => (
                    <AutomationListItem
                      key={
                        tile.id ??
                        automationTitle(tile, t("fallbacks.untitledAutomation"))
                      }
                      tile={tile}
                      selected={tile.id === selectedAutomationId}
                      onSelect={() => {
                        if (!tile.id) return;
                        setBuilderOpen(false);
                        setEditingAutomationId(null);
                        setDeleteAutomationId(null);
                        setMutationError(null);
                        setSelectedAutomationId(tile.id);
                        setSelectedRunKey(null);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={t("list.emptyTitle")}
                  body={t("list.emptyBody")}
                />
              )}
            </div>
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto">
          {builderOpen ? (
            <AutomationBuilderPanel
              onClose={() => setBuilderOpen(false)}
              onAutomationCreated={(automationId) => {
                if (automationId) {
                  setPendingCreatedAutomationId(automationId);
                  setSelectedAutomationId(automationId);
                  setSelectedRunKey(null);
                  setBuilderOpen(false);
                }
                void automationsQuery.refetch().then(() => {
                  if (!automationId) {
                    return;
                  }
                  if (delayedRefetchTimeoutRef.current) {
                    clearTimeout(delayedRefetchTimeoutRef.current);
                  }
                  // kgoose list propagation can lag tile creation, so refetch
                  // once more after the immediate refresh.
                  delayedRefetchTimeoutRef.current = setTimeout(() => {
                    void automationsQuery.refetch();
                    delayedRefetchTimeoutRef.current = null;
                  }, 1_500);
                });
              }}
            />
          ) : !detailTile ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                title={t("details.selectTitle")}
                body={t("details.selectBody")}
              />
            </div>
          ) : (
            <div className="mx-auto max-w-5xl p-5 lg:p-8">
              <header className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {detailTile.schedulePaused ? (
                        <IconPlayerPause
                          className="size-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <IconBolt className="size-4" aria-hidden="true" />
                      )}
                      <span>{formatSchedule(detailTile, scheduleLabels)}</span>
                    </div>
                    <h2 className="mt-2 break-words text-2xl font-medium text-foreground">
                      {automationTitle(
                        detailTile,
                        t("fallbacks.untitledAutomation"),
                      )}
                    </h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={statusVariant(detailTile.latestRunStatus)}>
                      {statusIcon(detailTile.latestRunStatus)}
                      {formatStatus(
                        detailTile.latestRunStatus,
                        t("fallbacks.unknown"),
                      )}
                    </Badge>
                    {detailQuery.error && (
                      <Badge variant="destructive">
                        <IconAlertTriangle aria-hidden="true" />
                        {t("details.stale")}
                      </Badge>
                    )}
                    {detailTileId && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setMutationError(null);
                            setEditingAutomationId(detailTileId);
                          }}
                          disabled={updateMutation.isPending}
                        >
                          <IconPencil aria-hidden="true" />
                          {t("actions.edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            setMutationError(null);
                            setDeleteAutomationId(detailTileId);
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          <IconTrash aria-hidden="true" />
                          {t("actions.delete")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </header>

              {mutationError && !isEditing && (
                <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {mutationError}
                </div>
              )}

              <Tabs defaultValue="details" className="mt-6">
                <TabsList variant="buttons">
                  <TabsTrigger value="details" variant="buttons">
                    {t("tabs.details")}
                  </TabsTrigger>
                  <TabsTrigger value="history" variant="buttons">
                    {t("tabs.history")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="details" className="mt-5">
                  {isEditing ? (
                    <AutomationEditForm
                      tile={detailTile}
                      isSaving={updateMutation.isPending}
                      saveError={mutationError}
                      onCancel={() => {
                        setMutationError(null);
                        setEditingAutomationId(null);
                      }}
                      onSave={(request) => updateMutation.mutate(request)}
                    />
                  ) : (
                    <AutomationDetails tile={detailTile} />
                  )}
                </TabsContent>
                <TabsContent value="history" className="mt-5">
                  {detailTile.id ? (
                    <AutomationHistory
                      tileId={detailTile.id}
                      selectedRunKey={selectedRunKey}
                      onSelectRun={setSelectedRunKey}
                    />
                  ) : (
                    <EmptyState
                      title={t("history.unavailableTitle")}
                      body={t("history.unavailableBody")}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </main>
      </div>
      <ConfirmDialog
        open={Boolean(deleteAutomationId)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteAutomationId(null);
          }
        }}
        title={t("delete.title")}
        description={t("delete.description", {
          name: deleteAutomationName,
        })}
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("actions.delete")}
        loadingLabel={t("actions.deleting")}
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteAutomationId) {
            deleteMutation.mutate(deleteAutomationId);
          }
        }}
      />
    </div>
  );
}
