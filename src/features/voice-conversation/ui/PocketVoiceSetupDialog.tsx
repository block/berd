import { Download, Headphones, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Progress } from "@/shared/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";
import type { PocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import type { VoiceModelKind } from "../api/pocketVoice";

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function PocketVoiceSetupDialog({
  open,
  onOpenChange,
  onUseSelected,
  setup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseSelected?: () => void;
  setup: PocketVoiceSetup;
}) {
  const { t } = useTranslation("settings");
  const { status } = setup;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("voice.title")}</DialogTitle>
          <DialogDescription>{t("voice.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <PocketVoiceSetupContent setup={setup} />
        </DialogBody>
        <DialogFooter>
          {status?.installed ? (
            <Button
              type="button"
              data-testid="pocket-use-selected"
              onClick={() => {
                if (onUseSelected) {
                  onUseSelected();
                  return;
                }
                onOpenChange(false);
              }}
            >
              <Headphones className="size-4" />
              {t("voice.useSelected")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("voice.notNow")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PocketVoiceSetupContent({
  setup,
  presentation = "dialog",
}: {
  setup: PocketVoiceSetup;
  presentation?: "dialog" | "settings";
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
  const isSettingsPresentation = presentation === "settings";
  const models = [
    {
      model: "pocket" as const,
      label: "Pocket TTS",
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
      label: "Parakeet STT",
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
  ];

  return (
    <div
      className={cn("space-y-4", isSettingsPresentation && "overflow-hidden")}
    >
      <div
        className={cn(
          isSettingsPresentation
            ? "divide-y divide-border"
            : "space-y-2 rounded-md border border-border p-4",
        )}
      >
        {models.map(
          ({
            model,
            label,
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
              className={cn(
                !isSettingsPresentation &&
                  "border-b border-border last:border-b-0 last:pb-0 first:pt-0",
              )}
              label={label}
              description={
                installed
                  ? t("voice.modelInstalledSize", {
                      size: formatBytes(diskBytes ?? 0),
                    })
                  : t("voice.modelMissingSize", {
                      size: formatBytes(downloadBytes),
                    })
              }
              action={
                inProgress ? undefined : installed ? (
                  <Button
                    type="button"
                    variant="outline"
                    destructive
                    size="sm"
                    data-testid={`voice-model-${model}-remove`}
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

      {error || (status && pocketInstalled) ? (
        <div className={cn("space-y-4", isSettingsPresentation && "px-4 pb-4")}>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          {status && pocketInstalled ? (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("voice.playbackSpeed")}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {[0.75, 1, 1.25, 1.5, 2].map((speed) => (
                    <Button
                      key={speed}
                      type="button"
                      size="sm"
                      variant={
                        status.playbackSpeed === speed ? "primary" : "outline"
                      }
                      aria-pressed={status.playbackSpeed === speed}
                      onClick={() => void setup.setPlaybackSpeed(speed)}
                    >
                      {speed}×
                    </Button>
                  ))}
                </div>
              </fieldset>
              <RadioGroup
                value={status.selectedVoice}
                onValueChange={(voiceId) => void setup.selectVoice(voiceId)}
                className="grid grid-cols-2 gap-2"
                aria-label={t("voice.voiceLabel")}
              >
                {status.voices.map((voice) => (
                  <div
                    key={voice.id}
                    data-testid={`pocket-voice-${voice.id}`}
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
            </>
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
