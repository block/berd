import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { clearOpenAiSttApiKey, setOpenAiSttApiKey } from "../api/openAiVoice";
import { useOpenAiVoiceSetup } from "../hooks/useOpenAiVoiceSetup";
import {
  DEFAULT_OPENAI_VOICE,
  openAiVoiceOptions,
} from "../lib/openAiVoiceOptions";
import {
  type RealtimePresentationMode,
  useRealtimeVoicePreference,
} from "../lib/realtimeVoicePreference";
import { OpenAiApiKeyField } from "./OpenAiApiKeyField";
import { SimpleVoicePickerDialog } from "./SimpleVoicePickerDialog";

const GPT_LIVE_VOICES = [
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
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
] as const;

export function RealtimeVoiceSettings() {
  const { t } = useTranslation("settings");
  const { preference, setPreference } = useRealtimeVoicePreference();
  const { status: openAiStatus } = useOpenAiVoiceSetup();
  const voiceOptions = openAiVoiceOptions([
    preference.voice,
    ...GPT_LIVE_VOICES,
  ]);

  const update = (patch: Partial<typeof preference>) => {
    setPreference({ ...preference, ...patch });
  };

  return (
    <section className="space-y-5 py-2 pr-4">
      <OpenAiApiKeyField
        label={t("voice.realtimeApiKey")}
        configured={openAiStatus?.sttConfigured ?? false}
        onSave={setOpenAiSttApiKey}
        onClear={clearOpenAiSttApiKey}
        description={t("voice.realtimeApiKeyDescription")}
      />

      <SimpleVoicePickerDialog
        options={voiceOptions}
        selectedVoice={preference.voice}
        defaultVoice={DEFAULT_OPENAI_VOICE}
        onChange={(voice) => update({ voice })}
      />

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="group px-0">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            {t("voice.realtimeAdvanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-3">
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
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
