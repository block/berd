import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { useSiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import { useVoiceOutputPreference } from "../lib/voiceOutputPreference";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupContent";
import { SiriVoiceSettings } from "./SiriVoiceSettings";

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();
  const output = useVoiceOutputPreference();
  const siriSetup = useSiriVoiceSetup(output.backend === "siri");
  const siriSupported = getPlatform() === "mac";
  const outputHeadingId = useId();
  const outputDescriptionId = useId();

  return (
    <SettingsPage
      title={t("nav.voice")}
      description={t("voice.settingsDescription")}
      contentClassName="space-y-6"
    >
      <section className="space-y-2 overflow-hidden">
        <h2 className="text-sm font-medium">{t("voice.speechInput")}</h2>
        <PocketVoiceSetupContent
          setup={setup}
          presentation="settings"
          models={["parakeet"]}
          showPocketVoiceControls={false}
        />
      </section>
      <section className="space-y-2 overflow-hidden">
        <div className="flex min-w-0 items-center gap-4 py-4 pr-4">
          <div className="min-w-0 flex-1">
            <h2 id={outputHeadingId} className="text-sm font-medium">
              {t("voice.speechOutput")}
            </h2>
            <p
              id={outputDescriptionId}
              className="mt-0.5 text-xs text-muted-foreground"
            >
              {t("voice.outputBackendDescription")}
            </p>
          </div>
          <div className="min-w-0 shrink-0">
            <Select
              value={output.backend}
              onValueChange={(value) =>
                output.setBackend(value as VoiceOutputBackend)
              }
            >
              <SelectTrigger
                aria-labelledby={outputHeadingId}
                aria-describedby={outputDescriptionId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pocket">
                  {t("voice.backendPocket")}
                </SelectItem>
                {siriSupported ? (
                  <SelectItem value="siri">{t("voice.backendSiri")}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
        </div>
        {output.backend === "siri" ? (
          <SiriVoiceSettings setup={siriSetup} />
        ) : (
          <PocketVoiceSetupContent
            setup={setup}
            presentation="settings"
            models={["pocket"]}
          />
        )}
      </section>
    </SettingsPage>
  );
}
