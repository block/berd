import { Download, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Progress } from "@/shared/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";
import type { VoiceModelKind } from "../api/pocketVoice";
import type { PocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { PlaybackSpeedRow } from "./PlaybackSpeedRow";
import { VoicePickerDialog } from "./VoicePickerDialog";

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function PocketVoiceSetupContent({
  setup,
  models: visibleModels,
  showPocketVoiceControls = true,
}: {
  setup: PocketVoiceSetup;
  models?: VoiceModelKind[];
  showPocketVoiceControls?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { status } = setup;
  const modelErrors = [status?.pocketError, status?.parakeetError];
  const error =
    setup.error && !modelErrors.includes(setup.error)
      ? setup.error
      : status?.error;
  const [pendingRemoval, setPendingRemoval] = useState<VoiceModelKind | null>(
    null,
  );
  const pocketInstalled = status?.pocketInstalled ?? status?.installed ?? false;
  const parakeetInstalled =
    status?.parakeetInstalled ?? status?.installed ?? false;
  const modelName = (model: VoiceModelKind) =>
    t(model === "pocket" ? "voice.backendPocket" : "voice.backendParakeet");
  const models = [
    {
      model: "pocket" as const,
      installed: pocketInstalled,
      diskBytes: status?.pocketSizeBytes ?? null,
      downloadBytes: status?.pocketDownloadBytes ?? 0,
      progress: status?.pocketProgress ?? null,
      inProgress: Boolean(
        status?.pocketProgress &&
          (status.activeModel === "pocket" ||
            status.pocketProgress.phase === "queued"),
      ),
      modelError: status?.pocketError ?? null,
    },
    {
      model: "parakeet" as const,
      installed: parakeetInstalled,
      diskBytes: status?.parakeetSizeBytes ?? null,
      downloadBytes: status?.parakeetDownloadBytes ?? 0,
      progress: status?.parakeetProgress ?? null,
      inProgress: Boolean(
        status?.parakeetProgress &&
          (status.activeModel === "parakeet" ||
            status.parakeetProgress.phase === "queued"),
      ),
      modelError: status?.parakeetError ?? null,
    },
  ].filter(({ model }) => !visibleModels || visibleModels.includes(model));
  const selectedVoice =
    status?.voices.find((voice) => voice.id === status.selectedVoice)?.name ??
    null;

  return (
    <div className="space-y-4 overflow-hidden">
      <div className="divide-y divide-border">
        {models.map(
          ({
            model,
            installed,
            diskBytes,
            downloadBytes,
            progress: modelProgress,
            inProgress,
            modelError,
          }) => (
            <SettingsRow
              key={model}
              data-testid={`voice-model-${model}`}
              label={
                visibleModels
                  ? installed
                    ? t("voice.modelInstalledSize", {
                        size: formatBytes(diskBytes ?? 0),
                      })
                    : t("voice.modelMissingSize", {
                        size: formatBytes(downloadBytes),
                      })
                  : modelName(model)
              }
              description={
                visibleModels
                  ? undefined
                  : installed
                    ? t("voice.modelInstalledSize", {
                        size: formatBytes(diskBytes ?? 0),
                      })
                    : t("voice.modelMissingSize", {
                        size: formatBytes(downloadBytes),
                      })
              }
              density="compact"
              className="rounded-md bg-muted/40 pl-3.5"
              action={
                inProgress ? undefined : installed ? (
                  <Button
                    type="button"
                    variant="outline"
                    destructive
                    size="sm"
                    data-testid={`voice-model-${model}-remove`}
                    aria-label={`${
                      setup.removingModel === model ||
                      status?.removing === model
                        ? status?.removalQueued
                          ? t("voice.removeModelQueued")
                          : t("voice.removingModel")
                        : t("voice.removeModel")
                    } · ${modelName(model)}`}
                    leftIcon={<Trash2 />}
                    disabled={
                      setup.removingModel !== null || status?.removing !== null
                    }
                    onClick={() => setPendingRemoval(model)}
                  >
                    {setup.removingModel === model || status?.removing === model
                      ? status?.removalQueued
                        ? t("voice.removeModelQueued")
                        : t("voice.removingModel")
                      : t("voice.removeModel")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`voice-model-${model}-download`}
                    aria-label={`${
                      modelError
                        ? t("voice.retryDownload")
                        : t("voice.download")
                    } · ${modelName(model)}`}
                    leftIcon={<Download />}
                    disabled={setup.loading || setup.removingModel !== null}
                    onClick={() => void setup.installModel(model)}
                  >
                    {modelError
                      ? t("voice.retryDownload")
                      : t("voice.download")}
                  </Button>
                )
              }
              details={
                inProgress && modelProgress ? (
                  <div className="space-y-1" aria-live="polite">
                    <Progress
                      aria-label={modelName(model)}
                      value={
                        modelProgress.totalBytes > 0
                          ? (modelProgress.downloadedBytes /
                              modelProgress.totalBytes) *
                            100
                          : 0
                      }
                    />
                    <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        {t(`voice.downloadPhase.${modelProgress.phase}`)}
                      </span>
                      <span>
                        {t("voice.downloadProgress", {
                          downloaded: formatBytes(
                            modelProgress.downloadedBytes,
                          ),
                          total: formatBytes(modelProgress.totalBytes),
                        })}
                      </span>
                    </div>
                  </div>
                ) : !installed && modelError ? (
                  <p className="text-xs text-destructive" role="alert">
                    {modelError}
                  </p>
                ) : undefined
              }
            />
          ),
        )}
      </div>

      {error || (showPocketVoiceControls && status && pocketInstalled) ? (
        <div className="space-y-4 px-4 pb-4">
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          {showPocketVoiceControls && status && pocketInstalled ? (
            <div className="divide-y divide-border">
              <PlaybackSpeedRow
                speed={status.playbackSpeed}
                speeds={[0.75, 1, 1.25, 1.5, 2]}
                onChange={setup.setPlaybackSpeed}
              />
              <VoicePickerDialog
                selectedVoice={selectedVoice}
                dialogError={error}
              >
                <RadioGroup
                  value={status.selectedVoice}
                  onValueChange={(voiceId) => void setup.selectVoice(voiceId)}
                  className="space-y-2"
                  aria-label={t("voice.voice")}
                >
                  {status.voices.map((voice) => (
                    <div
                      key={voice.id}
                      data-testid={`pocket-voice-${voice.id}`}
                      data-voice-selected={
                        voice.id === status.selectedVoice || undefined
                      }
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <label
                        htmlFor={`pocket-voice-${voice.id}`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                      >
                        <RadioGroupItem
                          id={`pocket-voice-${voice.id}`}
                          value={voice.id}
                        />
                        <span>{voice.name}</span>
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("voice.previewVoice", {
                          voice: voice.name,
                        })}
                        disabled={setup.previewingVoiceId !== null}
                        onClick={() => void setup.previewVoice(voice.id)}
                      >
                        <Play className="size-3.5" />
                        {setup.previewingVoiceId === voice.id
                          ? t("voice.playing")
                          : t("voice.preview")}
                      </Button>
                    </div>
                  ))}
                </RadioGroup>
              </VoicePickerDialog>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title={t("voice.removeModelTitle", {
          model: pendingRemoval === "parakeet" ? "Parakeet STT" : "Pocket TTS",
        })}
        description={t("voice.removeModelDescription", {
          model: pendingRemoval === "parakeet" ? "Parakeet STT" : "Pocket TTS",
        })}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("voice.removeModel")}
        loadingLabel={t("voice.removingModel")}
        isLoading={setup.removingModel !== null}
        onConfirm={async () => {
          if (!pendingRemoval) return;
          await setup.removeModel(pendingRemoval);
          setPendingRemoval(null);
        }}
      />
    </div>
  );
}
