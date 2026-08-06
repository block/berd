import { useCallback } from "react";
import { avatarRef } from "@/shared/avatars/catalog";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
  animateChosenGloopie,
  chooseGloopieOption,
  getGloopieGenerationJob,
  gloopieJobKey,
  resetGloopieGeneration,
  setGloopieObject,
  startGloopieGeneration,
  useGloopieGenerationStore,
  type GloopieOption,
  type GloopiePhase,
  type ResetGloopieGenerationOptions,
} from "@/features/agents/stores/gloopieGenerationStore";

export type { GloopieOption, GloopiePhase };

export interface GloopieGenerationState {
  phase: GloopiePhase;
  object: string;
  options: GloopieOption[];
  chosenOptionId: string | null;
  resultAvatarRef: string | null;
  sampleAvatarRef: string | null;
  errorCode: "networkAccess" | "contentBlocked" | "unavailable" | null;
  setObject: (value: string) => void;
  startGenerate: () => void;
  regenerate: () => void;
  /** Pass null to clear the current selection. */
  chooseOption: (optionId: string | null) => void;
  animate: () => void;
  /** Abandon the attempt and delete its generated media, except retained refs. */
  reset: (
    optionsOrKeepRefs?:
      | ResetGloopieGenerationOptions
      | readonly (string | null | undefined)[],
  ) => void;
}

const MOCK_GLOOPIE_COLLECTION_ID = "gloopies";
const MOCK_SAMPLE_GLOOPIE_AVATAR_ID = "gloopies-14";

function getCollectionAssetIds(
  library: AvatarLibraryState,
  collectionId: string,
): string[] {
  const catalog = library.catalog;
  if (!catalog) {
    return [];
  }

  const assetIds = new Set(catalog.assets.map((asset) => asset.id));
  const collectionAvatarIds =
    catalog.collections
      .find((collection) => collection.id === collectionId)
      ?.avatarIds.filter((id) => assetIds.has(id)) ?? [];

  if (collectionAvatarIds.length > 0) {
    return collectionAvatarIds;
  }

  return catalog.assets
    .filter((asset) => asset.collectionId === collectionId)
    .map((asset) => asset.id);
}

/**
 * React adapter for the session-scoped Gloopie generation manager.
 *
 * Long-running DAIM work is owned by the module-level store, not by the rail,
 * so saving, navigating away, or remounting the builder does not drop results.
 */
export function useGloopieGeneration(
  library: AvatarLibraryState,
  sessionId?: string,
): GloopieGenerationState {
  const key = gloopieJobKey(sessionId);
  const storedJob = useGloopieGenerationStore((state) => state.jobs[key]);
  const job = storedJob ?? getGloopieGenerationJob(sessionId);

  const setObject = useCallback(
    (value: string) => setGloopieObject(sessionId, value),
    [sessionId],
  );
  const startGenerate = useCallback(
    () => startGloopieGeneration(sessionId, library),
    [library, sessionId],
  );
  const chooseOption = useCallback(
    (optionId: string | null) => chooseGloopieOption(sessionId, optionId),
    [sessionId],
  );
  const animate = useCallback(
    () => animateChosenGloopie(sessionId),
    [sessionId],
  );
  const reset = useCallback(
    (
      optionsOrKeepRefs?:
        | ResetGloopieGenerationOptions
        | readonly (string | null | undefined)[],
    ) => resetGloopieGeneration(sessionId, optionsOrKeepRefs),
    [sessionId],
  );

  const gloopieIds = getCollectionAssetIds(library, MOCK_GLOOPIE_COLLECTION_ID);
  const sampleId = gloopieIds.includes(MOCK_SAMPLE_GLOOPIE_AVATAR_ID)
    ? MOCK_SAMPLE_GLOOPIE_AVATAR_ID
    : (gloopieIds[0] ?? library.catalog?.assets?.[0]?.id);

  // Project only the fields the UI renders. Spreading the whole job would leak
  // the store's apply-orchestration state (attempt ids, retry counters, target
  // paths) into a contract that does not declare it.
  return {
    phase: job.phase,
    object: job.object,
    options: job.options,
    chosenOptionId: job.chosenOptionId,
    resultAvatarRef: job.resultAvatarRef,
    errorCode: job.errorCode,
    sampleAvatarRef: sampleId ? avatarRef(sampleId) : null,
    setObject,
    startGenerate,
    regenerate: startGenerate,
    chooseOption,
    animate,
    reset,
  };
}
