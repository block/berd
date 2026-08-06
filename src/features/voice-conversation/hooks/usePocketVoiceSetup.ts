import { useCallback, useEffect, useState } from "react";
import {
  getPocketVoiceStatus,
  installVoiceModel,
  listenToPocketVoiceStatus,
  previewPocketVoice,
  removeVoiceModel,
  selectPocketVoice,
  stopPocketVoice,
  setPocketPlaybackSpeed,
  type PocketVoiceStatus,
  type VoiceModelKind,
} from "../api/pocketVoice";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";
import { logRendererEvent } from "@/shared/api/rendererTelemetry";

export interface PocketVoiceSetup {
  status: PocketVoiceStatus | null;
  loading: boolean;
  error: string | null;
  previewingVoiceId: string | null;
  removingModel: VoiceModelKind | null;
  installModel: (model: VoiceModelKind) => Promise<void>;
  previewVoice: (voiceId: string) => Promise<void>;
  selectVoice: (voiceId: string) => Promise<void>;
  setPlaybackSpeed: (speed: number) => Promise<void>;
  removeModel: (model: VoiceModelKind) => Promise<void>;
}

function progressSummary(status: PocketVoiceStatus): string {
  const format = (
    model: "pocket" | "parakeet",
    progress: PocketVoiceStatus["pocketProgress"],
  ) =>
    progress
      ? `${model}:${progress.attemptId}:${progress.phase}:${progress.downloadedBytes}/${progress.totalBytes}`
      : `${model}:none`;
  return [
    `revision=${status.statusRevision}`,
    `active=${status.activeModel ?? "none"}`,
    format("pocket", status.pocketProgress),
    format("parakeet", status.parakeetProgress),
  ].join(" ");
}

export function mergePocketVoiceStatus(
  current: PocketVoiceStatus | null,
  next: PocketVoiceStatus,
): PocketVoiceStatus {
  if (!current) {
    return next;
  }
  if (next.statusRevision < current.statusRevision) {
    void logRendererEvent(
      "warn",
      `[voice-model-progress] reject stale current=${progressSummary(current)} next=${progressSummary(next)}`,
    );
    return current;
  }
  const isStaleStatusAttempt = (
    currentAttemptId: number | null,
    nextAttemptId: number | null,
  ) =>
    currentAttemptId !== null &&
    nextAttemptId !== null &&
    nextAttemptId < currentAttemptId;
  const revivesRemovedAttempt = (
    currentAttemptId: number | null,
    currentProgress: PocketVoiceStatus["pocketProgress"],
    nextProgress: PocketVoiceStatus["pocketProgress"],
  ) =>
    currentAttemptId !== null &&
    currentProgress === null &&
    nextProgress?.attemptId === currentAttemptId;
  const isStaleAttempt = (
    currentProgress: PocketVoiceStatus["pocketProgress"],
    nextProgress: PocketVoiceStatus["pocketProgress"],
  ) =>
    currentProgress !== null &&
    nextProgress !== null &&
    nextProgress.attemptId < currentProgress.attemptId;
  const changesAttemptTotal = (
    currentProgress: PocketVoiceStatus["pocketProgress"],
    nextProgress: PocketVoiceStatus["pocketProgress"],
  ) =>
    currentProgress !== null &&
    nextProgress !== null &&
    nextProgress.attemptId === currentProgress.attemptId &&
    nextProgress.totalBytes !== currentProgress.totalBytes;
  if (
    isStaleStatusAttempt(current.pocketAttemptId, next.pocketAttemptId) ||
    isStaleStatusAttempt(current.parakeetAttemptId, next.parakeetAttemptId) ||
    revivesRemovedAttempt(
      current.pocketAttemptId,
      current.pocketProgress,
      next.pocketProgress,
    ) ||
    revivesRemovedAttempt(
      current.parakeetAttemptId,
      current.parakeetProgress,
      next.parakeetProgress,
    ) ||
    isStaleAttempt(current.pocketProgress, next.pocketProgress) ||
    isStaleAttempt(current.parakeetProgress, next.parakeetProgress) ||
    changesAttemptTotal(current.pocketProgress, next.pocketProgress) ||
    changesAttemptTotal(current.parakeetProgress, next.parakeetProgress)
  ) {
    void logRendererEvent(
      "warn",
      `[voice-model-progress] reject attempt current=${progressSummary(current)} next=${progressSummary(next)}`,
    );
    return current;
  }
  const mergeProgress = (
    currentProgress: PocketVoiceStatus["pocketProgress"],
    nextProgress: PocketVoiceStatus["pocketProgress"],
  ) => {
    if (!currentProgress || !nextProgress) return nextProgress;
    if (nextProgress.attemptId > currentProgress.attemptId) {
      return nextProgress;
    }
    if (nextProgress.attemptId < currentProgress.attemptId) {
      return currentProgress;
    }
    return {
      ...nextProgress,
      downloadedBytes: Math.max(
        currentProgress.downloadedBytes,
        nextProgress.downloadedBytes,
      ),
    };
  };
  return {
    ...next,
    pocketProgress: mergeProgress(current.pocketProgress, next.pocketProgress),
    parakeetProgress: mergeProgress(
      current.parakeetProgress,
      next.parakeetProgress,
    ),
  };
}

export function usePocketVoiceSetup(enabled = true): PocketVoiceSetup {
  const [status, setStatus] = useState<PocketVoiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(
    null,
  );
  const [removingModel, setRemovingModel] = useState<VoiceModelKind | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let active = true;
    let unlisten: (() => void) | undefined;
    // Mount probe: sibling voice surfaces share one IPC call.
    void getPocketVoiceStatus({ coalesce: true })
      .then((next) => {
        if (active)
          setStatus((current) => mergePocketVoiceStatus(current, next));
      })
      .catch((statusError) => {
        if (active) setError(String(statusError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void listenToPocketVoiceStatus((next) => {
      if (active) setStatus((current) => mergePocketVoiceStatus(current, next));
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [enabled]);

  const installModel = useCallback(async (model: VoiceModelKind) => {
    setError(null);
    try {
      const next = await installVoiceModel(model);
      setStatus((current) => mergePocketVoiceStatus(current, next));
    } catch (installError) {
      const message =
        installError instanceof Error
          ? installError.message
          : String(installError);
      setError(message);
      try {
        const refreshed = await getPocketVoiceStatus();
        setStatus((current) => mergePocketVoiceStatus(current, refreshed));
      } catch {
        // Preserve the actionable install error when status refresh also fails.
      }
    }
  }, []);

  const selectVoice = useCallback(async (voiceId: string) => {
    setError(null);
    try {
      await selectPocketVoice(voiceId);
      const refreshed = await getPocketVoiceStatus();
      setStatus((current) => mergePocketVoiceStatus(current, refreshed));
    } catch (selectionError) {
      setError(String(selectionError));
    }
  }, []);

  const setPlaybackSpeed = useCallback(async (speed: number) => {
    setError(null);
    try {
      await setPocketPlaybackSpeed(speed);
      const refreshed = await getPocketVoiceStatus();
      setStatus((current) => mergePocketVoiceStatus(current, refreshed));
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      throw nextError;
    }
  }, []);

  const previewVoice = useCallback(async (voiceId: string) => {
    setError(null);
    setPreviewingVoiceId(voiceId);
    try {
      await previewPocketVoice(voiceId);
    } catch (previewError) {
      setError(String(previewError));
    } finally {
      setPreviewingVoiceId(null);
    }
  }, []);

  const removeModel = useCallback(
    async (model: VoiceModelKind) => {
      if (!enabled) return;
      setError(null);
      setRemovingModel(model);
      try {
        const voice = useVoiceConversationStore.getState();
        if (
          voice.status.lifecycle !== "stopped" &&
          voice.status.lifecycle !== "unavailable"
        ) {
          await voice.stop();
        }
        if (model === "pocket") {
          await stopPocketVoice();
        }
        const next = await removeVoiceModel(model);
        setStatus((current) => mergePocketVoiceStatus(current, next));
      } catch (removalError) {
        setError(
          removalError instanceof Error
            ? removalError.message
            : String(removalError),
        );
        try {
          const refreshed = await getPocketVoiceStatus();
          setStatus((current) => mergePocketVoiceStatus(current, refreshed));
        } catch {
          // Preserve the removal error when status refresh also fails.
        }
        throw removalError;
      } finally {
        setRemovingModel(null);
      }
    },
    [enabled],
  );

  return {
    status,
    loading,
    error,
    previewingVoiceId,
    removingModel,
    installModel,
    previewVoice,
    selectVoice,
    setPlaybackSpeed,
    removeModel,
  };
}
