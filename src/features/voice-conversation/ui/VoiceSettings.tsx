import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
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
import { PocketVoiceSetupContent } from "./PocketVoiceSetupDialog";
import { SiriVoiceSettings } from "./SiriVoiceSettings";

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();
  const output = useVoiceOutputPreference();
  const siriSetup = useSiriVoiceSetup(output.backend === "siri");
  const siriSupported = getPlatform() === "mac";

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
        <h2 className="text-sm font-medium">{t("voice.speechOutput")}</h2>
        <SettingsRow
          label={t("voice.outputBackend")}
          description={t("voice.outputBackendDescription")}
          action={
            <Select
              value={output.backend}
              onValueChange={(value) =>
                output.setBackend(value as VoiceOutputBackend)
              }
            >
              <SelectTrigger aria-label={t("voice.outputBackend")}>
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
          }
        />
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
