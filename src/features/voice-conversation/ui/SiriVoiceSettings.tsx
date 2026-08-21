import { Check, Download, Play } from "lucide-react";
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

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function localeLabel(locale: string): string {
  try {
    return (
      new Intl.DisplayNames(undefined, { type: "language" }).of(locale) ??
      locale
    );
  } catch {
    return locale;
  }
}

function languageLabel(language: string): string {
  try {
    return (
      new Intl.DisplayNames(undefined, { type: "language" }).of(language) ??
      language
    );
  } catch {
    return language;
  }
}

function groupVoicesByLocale(voices: SiriVoice[]) {
  const groups = new Map<string, SiriVoice[]>();
  for (const voice of voices) {
    groups.set(voice.language, [...(groups.get(voice.language) ?? []), voice]);
  }
  return Array.from(groups, ([locale, groupedVoices]) => ({
    locale,
    voices: groupedVoices.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  })).sort((left, right) =>
    localeLabel(left.locale).localeCompare(localeLabel(right.locale)),
  );
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function SiriVoiceSettings({ setup }: { setup: SiriVoiceSetup }) {
  const { t } = useTranslation("settings");
  const languages = useMemo(
    () =>
      [...setup.languages].sort((left, right) =>
        languageLabel(left).localeCompare(languageLabel(right)),
      ),
    [setup.languages],
  );
  const groups = useMemo(
    () => groupVoicesByLocale(setup.status?.voices ?? []),
    [setup.status?.voices],
  );
  const selectedKey = setup.status?.selectedVoice
    ? voiceKey(setup.status.selectedVoice)
    : null;

  if (setup.status && !setup.status.supported) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("voice.siriUnsupported")}
      </p>
    );
  }

  return (
    <div className="space-y-5 px-4 pb-4">
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
                {languageLabel(language)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("voice.siriLanguageDescription")}
        </p>
      </div>

      {setup.status ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            {t("voice.playbackSpeed")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {PLAYBACK_SPEEDS.map((speed) => (
              <Button
                key={speed}
                type="button"
                size="sm"
                variant={
                  setup.status?.playbackSpeed === speed ? "primary" : "outline"
                }
                aria-pressed={setup.status?.playbackSpeed === speed}
                onClick={() => void setup.setPlaybackSpeed(speed)}
              >
                {speed}×
              </Button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {setup.error ? (
        <p className="text-sm text-destructive" role="alert">
          {setup.error}
        </p>
      ) : null}

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
              <h3 className="text-sm font-medium">
                {localeLabel(group.locale)}
              </h3>
              <div className="divide-y divide-border rounded-md border border-border">
                {group.voices.map((voice) => {
                  const key = voiceKey(voice);
                  const selected = key === selectedKey;
                  const downloading = setup.downloadingVoiceKey === key;
                  const previewing = setup.previewingVoiceKey === key;
                  return (
                    <div
                      key={key}
                      className="flex min-h-12 items-center gap-3 px-3 py-2"
                      data-testid={`siri-voice-${key}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <span>{voice.name}</span>
                          {selected ? (
                            <Check
                              className="size-3.5 text-primary"
                              aria-label={t("voice.siriSelected")}
                            />
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {voice.installed
                            ? t("voice.siriInstalled")
                            : t("voice.siriDownloadSize", {
                                size: formatBytes(voice.sizeBytes),
                              })}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={setup.previewingVoiceKey !== null}
                        aria-label={t(
                          previewing
                            ? "voice.playingVoice"
                            : "voice.previewVoice",
                          { voice: voice.name },
                        )}
                        onClick={() => void setup.previewVoice(voice)}
                      >
                        <Play className="size-3.5" />
                        {previewing ? t("voice.playing") : t("voice.preview")}
                      </Button>
                      {voice.installed ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={selected ? "primary" : "outline"}
                          disabled={selected}
                          aria-label={
                            selected
                              ? t("voice.selectedVoice", {
                                  voice: voice.name,
                                })
                              : t("voice.useVoice", {
                                  voice: voice.name,
                                })
                          }
                          onClick={() => void setup.selectVoice(voice)}
                        >
                          {selected
                            ? t("voice.siriSelected")
                            : t("voice.siriUseVoice")}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={setup.downloadingVoiceKey !== null}
                          aria-label={t(
                            downloading
                              ? "voice.downloadingVoice"
                              : "voice.downloadVoice",
                            { voice: voice.name },
                          )}
                          onClick={() => void setup.downloadVoice(voice)}
                        >
                          <Download className="size-3.5" />
                          {downloading
                            ? t("voice.siriDownloading")
                            : t("voice.download")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export { groupVoicesByLocale, languageLabel, localeLabel };
