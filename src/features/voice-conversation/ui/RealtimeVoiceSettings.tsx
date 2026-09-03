import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Label } from "@/shared/ui/label";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import {
  type RealtimeEagerness,
  type RealtimeNoiseReduction,
  type RealtimePresentationMode,
  type RealtimeReasoningEffort,
  type RealtimeTurnDetection,
  useRealtimeVoicePreference,
} from "../lib/realtimeVoicePreference";
import { clearOpenAiSttApiKey, setOpenAiSttApiKey } from "../api/openAiVoice";
import { useOpenAiVoiceSetup } from "../hooks/useOpenAiVoiceSetup";
import { OpenAiApiKeyField } from "./OpenAiApiKeyField";

const REALTIME_MODELS = [
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2",
  "gpt-realtime-1.5",
] as const;
const TRANSCRIPTION_MODELS = [
  "gpt-realtime-whisper",
  "gpt-live-transcribe",
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
] as const;
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

function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : null;
}

function OptionalCurrentSelectItem({
  value,
  knownValues,
}: {
  value: string;
  knownValues: readonly string[];
}) {
  return knownValues.includes(value) ? null : (
    <SelectItem value={value}>{value}</SelectItem>
  );
}

function SettingSwitch({
  checked,
  description,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  id: string;
  label: string;
  onCheckedChange(checked: boolean): void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border p-3">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function RealtimeVoiceSettings() {
  const { t } = useTranslation("settings");
  const { preference, setPreference } = useRealtimeVoicePreference();
  const { status: openAiStatus } = useOpenAiVoiceSetup();

  const update = (patch: Partial<typeof preference>) => {
    setPreference({ ...preference, ...patch });
  };

  return (
    <section className="space-y-5 py-2 pr-4">
      <div className="space-y-2">
        <OpenAiApiKeyField
          label={t("voice.realtimeApiKey")}
          configured={openAiStatus?.sttConfigured ?? false}
          onSave={setOpenAiSttApiKey}
          onClear={clearOpenAiSttApiKey}
        />
        <p className="text-xs text-muted-foreground">
          {t("voice.realtimeApiKeyDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="openai-realtime-presentation">
          {t("voice.realtimePresentation")}
        </Label>
        <Select
          value={preference.presentationMode}
          onValueChange={(presentationMode) =>
            update({
              presentationMode: presentationMode as RealtimePresentationMode,
            })
          }
        >
          <SelectTrigger id="openai-realtime-presentation" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">
              {t("voice.realtimePresentationDebug")}
            </SelectItem>
            <SelectItem value="subtle">
              {t("voice.realtimePresentationSubtle")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("voice.realtimePresentationDescription")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-model">
            {t("voice.realtimeModel")}
          </Label>
          <Select
            value={preference.model}
            onValueChange={(model) => update({ model })}
          >
            <SelectTrigger id="openai-realtime-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <OptionalCurrentSelectItem
                value={preference.model}
                knownValues={REALTIME_MODELS}
              />
              {REALTIME_MODELS.map((model) => (
                <SelectItem key={model} value={model}>
                  {model === "gpt-realtime-2.1"
                    ? t("voice.defaultOption", { value: model })
                    : model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-transcription-model">
            {t("voice.realtimeTranscriptionModel")}
          </Label>
          <Select
            value={preference.transcriptionModel}
            onValueChange={(transcriptionModel) =>
              update({ transcriptionModel })
            }
          >
            <SelectTrigger
              id="openai-realtime-transcription-model"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <OptionalCurrentSelectItem
                value={preference.transcriptionModel}
                knownValues={TRANSCRIPTION_MODELS}
              />
              {TRANSCRIPTION_MODELS.map((model) => (
                <SelectItem key={model} value={model}>
                  {model === "gpt-realtime-whisper"
                    ? t("voice.defaultOption", { value: model })
                    : model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("voice.realtimeTranscriptionModelDescription")}
          </p>
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
              <OptionalCurrentSelectItem
                value={preference.voice}
                knownValues={REALTIME_VOICES}
              />
              {REALTIME_VOICES.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voice === "marin"
                    ? t("voice.defaultOption", { value: voiceLabel(voice) })
                    : voiceLabel(voice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="openai-realtime-turn-detection">
            {t("voice.realtimeTurnDetection")}
          </Label>
          <Select
            value={preference.turnDetection}
            onValueChange={(turnDetection) =>
              update({ turnDetection: turnDetection as RealtimeTurnDetection })
            }
          >
            <SelectTrigger
              id="openai-realtime-turn-detection"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="server_vad">
                {t("voice.defaultOption", {
                  value: t("voice.realtimeTurnDetectionServer"),
                })}
              </SelectItem>
              <SelectItem value="semantic_vad">
                {t("voice.realtimeTurnDetectionSemantic")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {preference.turnDetection === "semantic_vad" ? (
          <div className="space-y-2">
            <Label htmlFor="openai-realtime-eagerness">
              {t("voice.realtimeEagerness")}
            </Label>
            <Select
              value={preference.eagerness}
              onValueChange={(eagerness) =>
                update({ eagerness: eagerness as RealtimeEagerness })
              }
            >
              <SelectTrigger id="openai-realtime-eagerness" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">
                  {t("voice.realtimeEagernessLow")}
                </SelectItem>
                <SelectItem value="auto">
                  {t("voice.defaultOption", {
                    value: t("voice.realtimeEagernessAuto"),
                  })}
                </SelectItem>
                <SelectItem value="medium">
                  {t("voice.realtimeEagernessMedium")}
                </SelectItem>
                <SelectItem value="high">
                  {t("voice.realtimeEagernessHigh")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
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

      <SettingSwitch
        id="openai-realtime-interrupt-response"
        label={t("voice.realtimeInterruptResponse")}
        description={t("voice.realtimeInterruptResponseDescription")}
        checked={preference.interruptResponse}
        onCheckedChange={(interruptResponse) => update({ interruptResponse })}
      />

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="group px-0">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            {t("voice.realtimeAdvanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-5 pt-3">
          <SettingSwitch
            id="openai-realtime-create-response"
            label={t("voice.realtimeCreateResponse")}
            description={t("voice.realtimeCreateResponseDescription")}
            checked={preference.createResponse}
            onCheckedChange={(createResponse) => update({ createResponse })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="openai-realtime-reasoning">
                {t("voice.realtimeReasoningEffort")}
              </Label>
              <Select
                value={preference.reasoningEffort}
                onValueChange={(reasoningEffort) =>
                  update({
                    reasoningEffort: reasoningEffort as RealtimeReasoningEffort,
                  })
                }
              >
                <SelectTrigger id="openai-realtime-reasoning">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["default", "none", "low", "medium", "high"] as const).map(
                    (effort) => (
                      <SelectItem key={effort} value={effort}>
                        {t(`voice.realtimeReasoningEfforts.${effort}`)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="openai-realtime-noise-reduction">
                {t("voice.realtimeNoiseReduction")}
              </Label>
              <Select
                value={preference.noiseReduction}
                onValueChange={(noiseReduction) =>
                  update({
                    noiseReduction: noiseReduction as RealtimeNoiseReduction,
                  })
                }
              >
                <SelectTrigger id="openai-realtime-noise-reduction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">
                    {t("voice.defaultOption", {
                      value: t("voice.realtimeNoiseReductionOff"),
                    })}
                  </SelectItem>
                  <SelectItem value="near_field">
                    {t("voice.realtimeNoiseReductionNear")}
                  </SelectItem>
                  <SelectItem value="far_field">
                    {t("voice.realtimeNoiseReductionFar")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="openai-realtime-language">
                {t("voice.realtimeTranscriptionLanguage")}
              </Label>
              <Input
                id="openai-realtime-language"
                value={preference.transcriptionLanguage}
                placeholder={t(
                  "voice.realtimeTranscriptionLanguagePlaceholder",
                )}
                onChange={(event) =>
                  update({ transcriptionLanguage: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="openai-realtime-max-output-tokens">
                {t("voice.realtimeMaxOutputTokens")}
              </Label>
              <Input
                id="openai-realtime-max-output-tokens"
                type="number"
                min={1}
                max={4096}
                value={preference.maxOutputTokens ?? ""}
                placeholder={t("voice.realtimeUnlimited")}
                onChange={(event) =>
                  event.target.value
                    ? (() => {
                        const maxOutputTokens = boundedInteger(
                          event.target.value,
                          1,
                          4_096,
                        );
                        if (maxOutputTokens !== null)
                          update({ maxOutputTokens });
                      })()
                    : update({ maxOutputTokens: null })
                }
              />
            </div>
          </div>

          {preference.turnDetection === "server_vad" ? (
            <div className="space-y-5 rounded-lg border p-4">
              <h3 className="text-sm font-medium">
                {t("voice.realtimeServerVad")}
              </h3>
              <div className="space-y-2">
                <div className="flex justify-between gap-4">
                  <Label htmlFor="openai-realtime-vad-threshold">
                    {t("voice.realtimeVadThreshold")}
                  </Label>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {preference.vadThreshold.toFixed(2)}
                  </span>
                </div>
                <Slider
                  id="openai-realtime-vad-threshold"
                  min={0}
                  max={1}
                  step={0.05}
                  value={[preference.vadThreshold]}
                  onValueChange={([vadThreshold]) => update({ vadThreshold })}
                  aria-label={t("voice.realtimeVadThreshold")}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="openai-realtime-silence-duration">
                    {t("voice.realtimeSilenceDuration")}
                  </Label>
                  <Input
                    id="openai-realtime-silence-duration"
                    type="number"
                    min={100}
                    max={3000}
                    step={50}
                    value={preference.silenceDurationMs}
                    onChange={(event) => {
                      const silenceDurationMs = boundedInteger(
                        event.target.value,
                        100,
                        3_000,
                      );
                      if (silenceDurationMs !== null)
                        update({ silenceDurationMs });
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openai-realtime-prefix-padding">
                    {t("voice.realtimePrefixPadding")}
                  </Label>
                  <Input
                    id="openai-realtime-prefix-padding"
                    type="number"
                    min={0}
                    max={2000}
                    step={50}
                    value={preference.prefixPaddingMs}
                    onChange={(event) => {
                      const prefixPaddingMs = boundedInteger(
                        event.target.value,
                        0,
                        2_000,
                      );
                      if (prefixPaddingMs !== null) update({ prefixPaddingMs });
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openai-realtime-idle-timeout">
                    {t("voice.realtimeIdleTimeout")}
                  </Label>
                  <Input
                    id="openai-realtime-idle-timeout"
                    type="number"
                    min={1000}
                    max={120000}
                    step={1000}
                    value={preference.idleTimeoutMs ?? ""}
                    placeholder={t("voice.realtimeOff")}
                    onChange={(event) =>
                      event.target.value
                        ? (() => {
                            const idleTimeoutMs = boundedInteger(
                              event.target.value,
                              1_000,
                              120_000,
                            );
                            if (idleTimeoutMs !== null)
                              update({ idleTimeoutMs });
                          })()
                        : update({ idleTimeoutMs: null })
                    }
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="openai-realtime-transcription-prompt">
              {t("voice.realtimeTranscriptionPrompt")}
            </Label>
            <Textarea
              id="openai-realtime-transcription-prompt"
              value={preference.transcriptionPrompt}
              placeholder={t("voice.realtimeTranscriptionPromptPlaceholder")}
              onChange={(event) =>
                update({ transcriptionPrompt: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("voice.realtimeTranscriptionPromptDescription")}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
