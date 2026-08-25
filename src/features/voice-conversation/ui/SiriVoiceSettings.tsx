import { Check, CloudDownload, Play } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SiriVoice } from "../api/siriVoice";
import type { SiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import { voiceKey } from "../hooks/useSiriVoiceSetup";
import { Button } from "@/shared/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { PlaybackSpeedRow } from "./PlaybackSpeedRow";
import { VoicePickerDialog } from "./VoicePickerDialog";

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function localeLabel(locale: string, displayLocale?: string): string {
  try {
    return (
      new Intl.DisplayNames(displayLocale ? [displayLocale] : undefined, {
        type: "language",
        languageDisplay: "standard",
      }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

function groupVoicesByLocale(
  voices: SiriVoice[],
  displayLocale: string,
  collator: Intl.Collator,
) {
  const groups = new Map<string, SiriVoice[]>();
  for (const voice of voices) {
    groups.set(voice.language, [...(groups.get(voice.language) ?? []), voice]);
  }
  return Array.from(groups, ([locale, groupedVoices]) => ({
    locale,
    voices: groupedVoices.sort((left, right) =>
      collator.compare(left.name, right.name),
    ),
  })).sort((left, right) =>
    collator.compare(
      localeLabel(left.locale, displayLocale),
      localeLabel(right.locale, displayLocale),
    ),
  );
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function SiriVoiceSettings({ setup }: { setup: SiriVoiceSetup }) {
  const { t, i18n } = useTranslation("settings");
  const displayLocale = i18n.resolvedLanguage ?? i18n.language;
  const collator = useMemo(
    () => new Intl.Collator(displayLocale),
    [displayLocale],
  );
  const languages = useMemo(
    () =>
      [...setup.languages].sort((left, right) =>
        collator.compare(
          localeLabel(left, displayLocale),
          localeLabel(right, displayLocale),
        ),
      ),
    [collator, displayLocale, setup.languages],
  );
  const groups = useMemo(
    () =>
      groupVoicesByLocale(setup.status?.voices ?? [], displayLocale, collator),
    [collator, displayLocale, setup.status?.voices],
  );
  const selectedKey = setup.status?.selectedVoice
    ? voiceKey(setup.status.selectedVoice)
    : null;
  const selectedVoice = setup.status?.selectedVoice?.name ?? null;

  if (setup.status && !setup.status.supported) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("voice.siriUnsupported")}
      </p>
    );
  }

  return (
    <div className="px-4 pb-4">
      <div className="divide-y divide-border">
        {setup.status ? (
          <PlaybackSpeedRow
            speed={setup.status.playbackSpeed}
            speeds={PLAYBACK_SPEEDS}
            onChange={setup.setPlaybackSpeed}
          />
        ) : null}
        <VoicePickerDialog
          selectedVoice={selectedVoice}
          dialogError={setup.error}
        >
          <div className="space-y-2">
            <label htmlFor="siri-language" className="text-sm font-medium">
              {t("voice.siriLanguage")}
            </label>
            <Select value={setup.language} onValueChange={setup.setLanguage}>
              <SelectTrigger id="siri-language" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((language) => (
                  <SelectItem key={language} value={language}>
                    {localeLabel(language, displayLocale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {setup.loading ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("voice.siriLoading")}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("voice.siriNoVoices")}
            </p>
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.locale} className="space-y-2">
                  {groups.length > 1 ? (
                    <h3 className="text-sm font-medium">
                      {localeLabel(group.locale, displayLocale)}
                    </h3>
                  ) : null}
                  <div className="divide-y divide-border rounded-md border border-border">
                    {group.voices.map((voice) => {
                      const key = voiceKey(voice);
                      const selected = key === selectedKey;
                      const downloading = setup.downloadingVoiceKey === key;
                      const previewing = setup.previewingVoiceKey === key;
                      const voiceDetails = (
                        <span className="min-w-0 text-left">
                          <span className="block truncate text-sm font-medium">
                            {voice.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {voice.installed
                              ? t("voice.modelInstalledSize", {
                                  size: formatBytes(voice.sizeBytes),
                                })
                              : formatBytes(voice.sizeBytes)}
                          </span>
                        </span>
                      );
                      return (
                        <div
                          key={key}
                          className="flex min-h-12 items-center gap-3 px-3 py-2"
                          data-testid={`siri-voice-${key}`}
                          data-voice-selected={selected || undefined}
                        >
                          {voice.installed ? (
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-auto min-w-0 flex-1 justify-start rounded-none p-0"
                              aria-label={t(
                                selected
                                  ? "voice.selectedVoice"
                                  : "voice.useVoice",
                                { voice: voice.name },
                              )}
                              aria-pressed={selected}
                              onClick={() => void setup.selectVoice(voice)}
                            >
                              {voiceDetails}
                            </Button>
                          ) : (
                            <div className="min-w-0 flex-1">{voiceDetails}</div>
                          )}
                          {selected ? (
                            <Check
                              className="size-5 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                          ) : null}
                          {!voice.installed ? (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              feedbackState={downloading ? "loading" : "idle"}
                              loadingVisual="spinner"
                              loadingLabel={t("voice.downloadingVoice", {
                                voice: voice.name,
                              })}
                              disabled={setup.downloadingVoiceKey !== null}
                              aria-label={t(
                                downloading
                                  ? "voice.downloadingVoice"
                                  : "voice.downloadVoice",
                                { voice: voice.name },
                              )}
                              tooltip={t("voice.downloadVoice", {
                                voice: voice.name,
                              })}
                              onClick={() => void setup.downloadVoice(voice)}
                            >
                              <CloudDownload />
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="outline"
                            feedbackState={previewing ? "loading" : "idle"}
                            loadingVisual="spinner"
                            loadingLabel={t("voice.playingVoice", {
                              voice: voice.name,
                            })}
                            disabled={setup.previewingVoiceKey !== null}
                            aria-label={t(
                              previewing
                                ? "voice.playingVoice"
                                : "voice.previewVoice",
                              { voice: voice.name },
                            )}
                            tooltip={t("voice.previewVoice", {
                              voice: voice.name,
                            })}
                            onClick={() => void setup.previewVoice(voice)}
                          >
                            <Play />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </VoicePickerDialog>
      </div>
      {setup.error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {setup.error}
        </p>
      ) : null}
    </div>
  );
}
