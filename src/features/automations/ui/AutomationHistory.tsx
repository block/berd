import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Accordion from "@radix-ui/react-accordion";
import { useTranslation } from "react-i18next";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { getAutomationTileResults } from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATIONS_REFETCH_INTERVAL_MS,
  automationTileResultsQueryKey,
} from "@/features/automations/api/automationTilesQuery";
import { keyAutomationResults } from "@/features/automations/lib/automationFormatting";
import { Spinner } from "@/shared/ui/spinner";
import { ExpandableHistoryRow } from "@/features/automations/ui/ExpandableHistoryRow";
import { EmptyState, RunOutput } from "@/features/automations/ui/RunOutput";

export function AutomationHistory({
  tile,
  tileId,
  selectedRunKey,
  onSelectRun,
}: {
  tile: AutomationTile;
  tileId: string;
  selectedRunKey: string | null;
  onSelectRun: (runKey: string | null) => void;
}) {
  const { t } = useTranslation("automations");
  const {
    data: historyData,
    error: historyError,
    isLoading: isHistoryLoading,
  } = useQuery({
    queryKey: automationTileResultsQueryKey(tileId),
    queryFn: () => getAutomationTileResults(tileId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });
  const results = keyAutomationResults(historyData?.tilesResults ?? []);
  const selectedRun = results.find((item) => item.runKey === selectedRunKey);
  const scrollSelectedRow = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView({
      block: "nearest",
    });
  }, []);

  if (isHistoryLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner className="size-5 text-primary" />
      </div>
    );
  }

  if (historyError) {
    return (
      <EmptyState
        title={t("history.loadErrorTitle")}
        body={historyError.message}
      />
    );
  }

  if (!results.length) {
    return (
      <EmptyState
        title={t("history.emptyTitle")}
        body={t("history.emptyBody")}
      />
    );
  }

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={selectedRun?.runKey ?? ""}
      onValueChange={(value) => {
        onSelectRun(value || null);
      }}
      className="space-y-4"
    >
      {results.map(({ result, runKey }) => (
        <div
          key={runKey}
          ref={runKey === selectedRun?.runKey ? scrollSelectedRow : undefined}
        >
          <ExpandableHistoryRow
            automation={tile}
            result={result}
            value={runKey}
          >
            <RunOutput result={result} />
          </ExpandableHistoryRow>
        </div>
      ))}
    </Accordion.Root>
  );
}
