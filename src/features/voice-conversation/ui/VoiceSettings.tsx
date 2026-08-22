import { CircleAlert } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
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

function readinessDescriptionKey(
  inputReady: boolean,
  outputReady: boolean,
  backend: VoiceOutputBackend,
): string | null {
  if (inputReady && outputReady) return null;
  if (!inputReady && !outputReady) {
    return backend === "siri"
      ? "voice.notReadyInputAndSiriOutput"
      : "voice.notReadyInputAndPocketOutput";
  }
  if (!inputReady) return "voice.notReadyInput";
  return backend === "siri"
    ? "voice.notReadySiriOutput"
    : "voice.notReadyPocketOutput";
}

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();
  const output = useVoiceOutputPreference();
  const siriSetup = useSiriVoiceSetup(output.backend === "siri");
  const siriSupported = getPlatform() === "mac";
  const outputHeadingId = useId();
  const outputDescriptionId = useId();
  const inputReady = setup.status?.parakeetInstalled ?? false;
  const outputReady =
    output.backend === "siri"
      ? Boolean(
          siriSetup.status?.supported &&
            siriSetup.status.selectedVoice &&
            siriSetup.status.selectedVoiceInstalled,
        )
      : (setup.status?.pocketInstalled ?? false);
  const readinessLoaded =
    setup.status !== null &&
    (output.backend === "pocket" ||
      siriSetup.status !== null ||
      siriSetup.error !== null);
  const readinessKey = readinessLoaded
    ? readinessDescriptionKey(inputReady, outputReady, output.backend)
    : null;

  return (
    <SettingsPage
      title={t("nav.voice")}
      description={t("voice.settingsDescription")}
      contentClassName="space-y-6"
    >
      {readinessKey ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{t("voice.notReadyTitle")}</AlertTitle>
          <AlertDescription>{t(readinessKey)}</AlertDescription>
        </Alert>
      ) : null}
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
