import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getOpenAiRealtimeStatus,
  saveOpenAiRealtimeApiKey,
} from "@/shared/api/openaiRealtime";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Textarea } from "@/shared/ui/textarea";
import {
  parseRealtimeSessionOverrides,
  useRealtimeVoicePreference,
} from "../lib/realtimeVoicePreference";

const REALTIME_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

function voiceLabel(voice: string): string {
  return `${voice.charAt(0).toUpperCase()}${voice.slice(1)}`;
}

export function RealtimeVoiceSettings() {
  const { t } = useTranslation("settings");
  const { preference, setPreference } = useRealtimeVoicePreference();
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getOpenAiRealtimeStatus()
      .then((status) => setConfigured(status.voiceConfigured))
      .catch(() => setConfigured(false));
  }, []);

  const saveKey = async () => {
    setSaving(true);
    try {
      await saveOpenAiRealtimeApiKey(apiKey);
      setApiKey("");
      setConfigured(true);
      toast.success(t("voice.realtimeApiKeySaved"));
    } catch (error) {
      toast.error(t("voice.realtimeApiKeySaveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<typeof preference>) => {
    setPreference({ ...preference, ...patch });
  };

  return (
    <section className="space-y-5 py-2 pr-4">
      <div className="space-y-2">
        <Label htmlFor="openai-realtime-api-key">
          {t("voice.realtimeApiKey")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="openai-realtime-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={
              configured
                ? t("voice.realtimeApiKeyConfigured")
                : t("voice.realtimeApiKeyPlaceholder")
            }
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            type="button"
            disabled={!apiKey.trim() || saving}
            onClick={() => void saveKey()}
          >
            {saving ? t("voice.realtimeSaving") : t("voice.realtimeSaveKey")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("voice.realtimeApiKeyDescription")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-model">
            {t("voice.realtimeModel")}
          </Label>
          <Input
            id="openai-realtime-model"
            value={preference.model}
            onChange={(event) => update({ model: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-transcription-model">
            {t("voice.realtimeTranscriptionModel")}
          </Label>
          <Input
            id="openai-realtime-transcription-model"
            value={preference.transcriptionModel}
            onChange={(event) =>
              update({ transcriptionModel: event.target.value })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-voice">
            {t("voice.realtimeVoice")}
          </Label>
          <Select
            value={preference.voice}
            onValueChange={(voice) => update({ voice })}
          >
            <SelectTrigger id="openai-realtime-voice" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!REALTIME_VOICES.includes(
                preference.voice as (typeof REALTIME_VOICES)[number],
              ) && (
                <SelectItem value={preference.voice}>
                  {voiceLabel(preference.voice)}
                </SelectItem>
              )}
              {REALTIME_VOICES.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voiceLabel(voice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="openai-realtime-speed">
            {t("voice.realtimeSpeed")}
          </Label>
          <span className="text-sm tabular-nums text-muted-foreground">
            {preference.speed.toFixed(2)}×
          </span>
        </div>
        <Slider
          id="openai-realtime-speed"
          min={0.25}
          max={1.5}
          step={0.05}
          value={[preference.speed]}
          onValueChange={([speed]) => update({ speed })}
          aria-label={t("voice.realtimeSpeed")}
        />
        <p className="text-xs text-muted-foreground">
          {t("voice.realtimeSpeedDescription")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="openai-realtime-overrides">
          {t("voice.realtimeAdvancedOptions")}
        </Label>
        <Textarea
          id="openai-realtime-overrides"
          className="min-h-40 font-mono text-xs"
          value={preference.sessionOverridesText}
          aria-invalid={(() => {
            try {
              parseRealtimeSessionOverrides(preference.sessionOverridesText);
              return undefined;
            } catch {
              return true;
            }
          })()}
          onChange={(event) =>
            update({ sessionOverridesText: event.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">
          {t("voice.realtimeAdvancedOptionsDescription")}
        </p>
      </div>
    </section>
  );
}
