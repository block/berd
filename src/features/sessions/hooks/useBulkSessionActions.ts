import { useCallback, useState } from "react";
import {
  applySessionActionToIds,
  type SessionAction,
} from "../lib/sessionSelection";

interface UseBulkSessionActionsOptions {
  selectedSessionIds: Set<string>;
  onComplete: () => void;
  onFailure: (failedCount: number) => void;
}

export function useBulkSessionActions({
  selectedSessionIds,
  onComplete,
  onFailure,
}: UseBulkSessionActionsOptions) {
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveSelectionSnapshot, setArchiveSelectionSnapshot] = useState<
    Set<string>
  >(() => new Set());
  const [isApplyingSelectionAction, setIsApplyingSelectionAction] =
    useState(false);

  const applySelectionAction = useCallback(
    async (action?: SessionAction, sessionIds = selectedSessionIds) => {
      if (!action || isApplyingSelectionAction || sessionIds.size === 0) return;

      setIsApplyingSelectionAction(true);
      try {
        const result = await applySessionActionToIds(sessionIds, action);
        if (result && result.failedCount > 0) {
          onFailure(result.failedCount);
        }
        return result;
      } finally {
        onComplete();
        setIsApplyingSelectionAction(false);
      }
    },
    [isApplyingSelectionAction, onComplete, onFailure, selectedSessionIds],
  );

  const requestArchiveSelected = useCallback(() => {
    setArchiveSelectionSnapshot(new Set(selectedSessionIds));
    setArchiveConfirmOpen(true);
  }, [selectedSessionIds]);

  const confirmArchiveSelected = useCallback(
    async (action?: SessionAction) => {
      const sessionIds = new Set(archiveSelectionSnapshot);
      setArchiveConfirmOpen(false);
      setArchiveSelectionSnapshot(new Set());
      await applySelectionAction(action, sessionIds);
    },
    [applySelectionAction, archiveSelectionSnapshot],
  );

  return {
    applySelectionAction,
    archiveConfirmOpen,
    archiveSelectionCount: archiveSelectionSnapshot.size,
    confirmArchiveSelected,
    isApplyingSelectionAction,
    requestArchiveSelected,
    setArchiveConfirmOpen,
  };
}
