import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconPlayerPause,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import {
  type AutomationTile,
  type AutomationTileResult,
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
} from "@/features/automations/api/kgooseAutomations";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
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

function getStableInstructionItems(instructions: string[]) {
  const occurrences = new Map<string, number>();
  return instructions.map((instruction) => {
    const occurrence = occurrences.get(instruction) ?? 0;
    occurrences.set(instruction, occurrence + 1);
    return {
      instruction,
      key:
        occurrence === 0 ? instruction : `${instruction} (${occurrence + 1})`,
    };
  });
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

  return (
    <section className="min-w-0 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("history.runOutput")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.sessionId ?? t("history.noSessionId")}
          </p>
        </div>
        <Badge variant={statusVariant(result.runStatus)}>
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </Badge>
      </div>
      <Separator className="my-4" />
      {summary ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {summary}
        </p>
      ) : result.tileData ? (
        <JsonPreview value={result.tileData} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("history.noOutputData")}
        </p>
      )}
    </section>
  );
}

export function AutomationsView() {
  const { t } = useTranslation("automations");
  const [selectedAutomationId, setSelectedAutomationId] = useState<
    string | null
  >(null);
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
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
      return;
    }
    setSelectedAutomationId(automations[0]?.id ?? null);
    setSelectedRunKey(null);
  }, [automations, selectedAutomationId]);

  const selectedAutomation = automations.find(
    (tile) => tile.id === selectedAutomationId,
  );

  const detailQuery = useQuery({
    queryKey: ["automationTile", selectedAutomationId],
    queryFn: () => getAutomationTile(selectedAutomationId ?? ""),
    enabled: Boolean(selectedAutomationId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const detailTile = detailQuery.data?.tileInfo ?? selectedAutomation;

  return (
    <div className="h-full overflow-hidden bg-background">
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[360px_1fr]">
        <aside className="min-h-0 border-b border-border lg:border-r lg:border-b-0">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <h1 className="text-xl font-medium text-foreground">
                  {t("title")}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("subtitle")}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => automationsQuery.refetch()}
                aria-label={t("actions.refresh")}
                title={t("actions.refresh")}
              >
                <IconRefresh aria-hidden="true" />
              </Button>
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
          {!detailTile ? (
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
                  </div>
                </div>
              </header>

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
                  <AutomationDetails tile={detailTile} />
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
    </div>
  );
}
