import { useTranslation } from "react-i18next";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupDialog";
import { SettingsPage } from "@/shared/ui/SettingsPage";

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();

  return (
    <SettingsPage
      title={t("nav.voice")}
      description={t("voice.settingsDescription")}
      contentClassName="space-y-6"
    >
      <section>
        <PocketVoiceSetupContent setup={setup} presentation="settings" />
      </section>
    </SettingsPage>
  );
}
