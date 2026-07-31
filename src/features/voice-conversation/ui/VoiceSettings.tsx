import { Headphones } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupDialog";
import { SettingsPage } from "@/shared/ui/SettingsPage";

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();

  return (
    <SettingsPage contentClassName="space-y-6">
      <section className="space-y-5 rounded-md bg-background px-6 py-5">
        <div className="flex items-start gap-3">
          <Headphones className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <h4 className="text-sm text-foreground">{t("nav.voice")}</h4>
            <p className="text-xs leading-4 text-muted-foreground">
              {t("voice.settingsDescription")}
            </p>
          </div>
        </div>
        <PocketVoiceSetupContent setup={setup} />
      </section>
    </SettingsPage>
  );
}
