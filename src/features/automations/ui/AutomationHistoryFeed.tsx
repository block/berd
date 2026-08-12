import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import * as Accordion from "@radix-ui/react-accordion";
import { useTranslation } from "react-i18next";
import { IconArrowRight } from "@tabler/icons-react";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { getAutomationTileResults } from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATIONS_REFETCH_INTERVAL_MS,
  automationTileResultsQueryKey,
} from "@/features/automations/api/automationTilesQuery";
import {
  getOutputBody,
  keyAutomationResults,
  runTimestamp,
  type KeyedAutomationRun,
  type SelectedAutomationRun,
} from "@/features/automations/lib/automationFormatting";
import { Button } from "@/shared/ui/button";
import { ExpandableHistoryRow } from "@/features/automations/ui/ExpandableHistoryRow";
import { EmptyState } from "@/features/automations/ui/RunOutput";
import { MessageResponse } from "@/shared/ui/ai-elements/message";

export function AutomationHistoryFeed({
  automations,
  selectedRun,
  onSelectRun,
  onOpenAutomation,
}: {
  automations: AutomationTile[];
  selectedRun: SelectedAutomationRun | null;
  onSelectRun: (run: SelectedAutomationRun | null) => void;
  onOpenAutomation: (run: SelectedAutomationRun) => void;
}) {
  const { t } = useTranslation("automations");
  const automationTiles = automations.filter((tile) => tile.id);
  const historyQueries = useQueries({
    queries: automationTiles.map((tile) => ({
      queryKey: automationTileResultsQueryKey(tile.id),
      queryFn: () => getAutomationTileResults(tile.id ?? ""),
      refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
      enabled: Boolean(tile.id),
    })),
  });
  const runs = historyQueries
    .flatMap((query, index): KeyedAutomationRun[] => {
      const automation = automationTiles[index];
      if (!automation) return [];
      return keyAutomationResults(query.data?.tilesResults ?? []).map(
        ({ result, runKey }) => ({
          automation,
          result,
          runKey,
        }),
      );
    })
    .sort((a, b) => runTimestamp(b.result) - runTimestamp(a.result));
  const isLoading = historyQueries.some((query) => query.isLoading);
  const firstError = historyQueries.find((query) => query.error)?.error;
  const selectedRunItem = selectedRun
    ? runs.find(
        (run) =>
          run.automation.id === selectedRun.automationId &&
          run.runKey === selectedRun.runKey,
      )
    : undefined;
  const selectedValue = selectedRunItem
    ? `${selectedRunItem.automation.id}:${selectedRunItem.runKey}`
    : "";
  const scrollSelectedRow = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView({
      block: "nearest",
    });
  }, []);
  const runValues = useMemo(
    () =>
      new Map(runs.map((run) => [`${run.automation.id}:${run.runKey}`, run])),
    [runs],
  );

  if (isLoading && !runs.length) {
    return (
      <div className="space-y-3">
        <div className="h-12 rounded-md bg-muted" />
        <div className="h-12 rounded-md bg-muted" />
        <div className="h-12 rounded-md bg-muted" />
      </div>
    );
  }

  if (!runs.length && firstError instanceof Error) {
    return (
      <EmptyState
        title={t("history.loadErrorTitle")}
        body={firstError.message}
      />
    );
  }

  if (!runs.length) {
    return (
      <EmptyState
        title={t("history.emptyTitle")}
        body={t("history.emptyBody")}
      />
    );
  }

  return (
    <section
      aria-label={t("history.runs")}
      className="relative min-h-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-48 after:bg-gradient-to-b after:from-transparent after:to-canvas-base"
    >
      <Accordion.Root
        type="single"
        collapsible
        value={selectedValue}
        onValueChange={(value) => {
          if (!value) {
            onSelectRun(null);
            return;
          }
          const run = runValues.get(value);
          if (run?.automation.id) {
            onSelectRun({
              automationId: run.automation.id,
              runKey: run.runKey,
            });
          }
        }}
        className="space-y-4 pb-20"
      >
        {runs.map(({ automation, result, runKey }) => (
          <div
            key={`${automation.id}:${runKey}`}
            ref={
              selectedRunItem &&
              automation.id === selectedRunItem.automation.id &&
              runKey === selectedRunItem.runKey
                ? scrollSelectedRow
                : undefined
            }
          >
            <ExpandableHistoryRow
              automation={automation}
              result={result}
              value={`${automation.id}:${runKey}`}
              showAutomationTitle
            >
              <div className="space-y-4">
                <MessageResponse className="min-w-0 text-sm leading-relaxed">
                  {getOutputBody(result.tileData) ??
                    result.sessionId ??
                    t("history.noOutputData")}
                </MessageResponse>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      if (automation.id) {
                        onOpenAutomation({
                          automationId: automation.id,
                          runKey,
                        });
                      }
                    }}
                    rightIcon={<IconArrowRight aria-hidden="true" />}
                  >
                    {t("history.goToAutomation")}
                  </Button>
                </div>
              </div>
            </ExpandableHistoryRow>
          </div>
        ))}
      </Accordion.Root>
    </section>
  );
}
