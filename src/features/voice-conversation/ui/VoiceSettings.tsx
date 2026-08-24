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
import { useMacSpeechSetup } from "../hooks/useMacSpeechSetup";
import { useSiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import {
  isMacSpeechAvailable,
  useVoiceInputPreference,
} from "../lib/voiceInputPreference";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import { useVoiceOutputPreference } from "../lib/voiceOutputPreference";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupContent";
import { MacSpeechSettings } from "./MacSpeechSettings";
import { SiriVoiceSettings } from "./SiriVoiceSettings";

function readinessDescriptionKey(
  inputReady: boolean,
  outputReady: boolean,
  backend: VoiceOutputBackend,
  inputBackend: VoiceInputBackend,
): string | null {
  if (inputReady && outputReady) return null;
  if (!inputReady && !outputReady) {
    if (inputBackend === "macos") {
      return backend === "siri"
        ? "voice.notReadyMacInputAndSiriOutput"
        : "voice.notReadyMacInputAndPocketOutput";
    }
    return backend === "siri"
      ? "voice.notReadyInputAndSiriOutput"
      : "voice.notReadyInputAndPocketOutput";
  }
  if (!inputReady) {
    return inputBackend === "macos"
      ? "voice.notReadyMacInput"
      : "voice.notReadyInput";
  }
  return backend === "siri"
    ? "voice.notReadySiriOutput"
    : "voice.notReadyPocketOutput";
}

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();
  const macSpeechSetup = useMacSpeechSetup();
  const input = useVoiceInputPreference(
    isMacSpeechAvailable(macSpeechSetup.status, macSpeechSetup.loading),
  );
  const output = useVoiceOutputPreference();
  const siriSetup = useSiriVoiceSetup(output.backend === "siri");
  const siriSupported = getPlatform() === "mac";
  const inputHeadingId = useId();
  const inputDescriptionId = useId();
  const outputHeadingId = useId();
  const outputDescriptionId = useId();
  const inputReady =
    input.backend === "macos"
      ? Boolean(
          macSpeechSetup.status?.supported &&
            macSpeechSetup.status.localeSupported &&
            macSpeechSetup.status.modelInstalled,
        )
      : (setup.status?.parakeetInstalled ?? false);
  const macSpeechAuthorizationRequired =
    input.backend === "macos" &&
    macSpeechSetup.status !== null &&
    macSpeechSetup.status.authorizationStatus !== "authorized";
  const outputReady =
    output.backend === "siri"
      ? Boolean(
          siriSetup.status?.supported &&
            siriSetup.status.selectedVoice &&
            siriSetup.status.selectedVoiceInstalled,
        )
      : (setup.status?.pocketInstalled ?? false);
  const siriOutputLoaded =
    siriSetup.status !== null && siriSetup.statusError === null;
  const pocketStatusLoaded =
    (input.backend !== "parakeet" && output.backend !== "pocket") ||
    setup.status !== null;
  const readinessKey = !pocketStatusLoaded
    ? null
    : macSpeechAuthorizationRequired
      ? outputReady
        ? "voice.notReadyMacPermission"
        : output.backend === "siri"
          ? "voice.notReadyMacPermissionAndSiriOutput"
          : "voice.notReadyMacPermissionAndPocketOutput"
      : !inputReady && output.backend === "siri" && !siriOutputLoaded
        ? input.backend === "macos"
          ? "voice.notReadyMacInput"
          : "voice.notReadyInput"
        : output.backend === "siri" && !siriOutputLoaded
          ? null
          : input.backend === null
            ? null
            : readinessDescriptionKey(
                inputReady,
                outputReady,
                output.backend,
                input.backend,
              );

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
        <div className="flex min-w-0 flex-col gap-4 py-4 pr-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 id={inputHeadingId} className="text-sm font-medium">
              {t("voice.speechInput")}
            </h2>
            <p
              id={inputDescriptionId}
              className="mt-0.5 text-xs text-muted-foreground"
            >
              {t("voice.inputBackendDescription")}
            </p>
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:shrink-0">
            <Select
              value={input.backend ?? undefined}
              disabled={input.backend === null}
              onValueChange={(value) =>
                input.setBackend(value as VoiceInputBackend)
              }
            >
              <SelectTrigger
                className="w-full sm:w-auto"
                aria-labelledby={inputHeadingId}
                aria-describedby={inputDescriptionId}
              >
                <SelectValue placeholder={t("voice.macSpeechLoading")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parakeet">
                  {t("voice.backendParakeet")}
                </SelectItem>
                {macSpeechSetup.status?.supported &&
                macSpeechSetup.status.localeSupported ? (
                  <SelectItem value="macos">
                    {t("voice.backendMacSpeech")}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
        </div>
        {input.backend === "macos" ? (
          <MacSpeechSettings setup={macSpeechSetup} />
        ) : input.backend === "parakeet" ? (
          <PocketVoiceSetupContent
            setup={setup}
            models={["parakeet"]}
            showPocketVoiceControls={false}
          />
        ) : null}
      </section>
      <section className="space-y-2">
        <div className="flex min-w-0 flex-col gap-4 py-4 pr-4 sm:flex-row sm:items-center">
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
          <div className="w-full min-w-0 sm:w-auto sm:shrink-0">
            <Select
              value={output.backend}
              onValueChange={(value) =>
                output.setBackend(value as VoiceOutputBackend)
              }
            >
              <SelectTrigger
                className="w-full sm:w-auto"
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
          <PocketVoiceSetupContent setup={setup} models={["pocket"]} />
        )}
      </section>
    </SettingsPage>
  );
}
