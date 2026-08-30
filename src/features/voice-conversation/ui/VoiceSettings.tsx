import { CircleAlert } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { RadioGroup, RadioGroupCard } from "@/shared/ui/radio-group";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { useEffect, useState } from "react";
import {
  clearOpenAiSttApiKey,
  clearOpenAiTtsApiKey,
  setOpenAiSttApiKey,
  setOpenAiPlaybackSpeed,
  setOpenAiTtsApiKey,
} from "../api/openAiVoice";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { useMacSpeechSetup } from "../hooks/useMacSpeechSetup";
import { useMicrophonePermission } from "../hooks/useMicrophonePermission";
import { useSiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import {
  isMacSpeechAvailable,
  useVoiceInputPreference,
} from "../lib/voiceInputPreference";
import type { VoiceInterruptionMode } from "../lib/voiceInterruptionPreference";
import { useVoiceInterruptionPreference } from "../lib/voiceInterruptionPreference";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import { useVoiceOutputPreference } from "../lib/voiceOutputPreference";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupContent";
import { MacSpeechSettings } from "./MacSpeechSettings";
import { SiriVoiceSettings } from "./SiriVoiceSettings";
import { PlaybackSpeedRow } from "./PlaybackSpeedRow";
import { useOpenAiVoiceSetup } from "../hooks/useOpenAiVoiceSetup";
import { OpenAiApiKeyField } from "./OpenAiApiKeyField";

const INTERRUPTION_MODES: VoiceInterruptionMode[] = [
  "automatic",
  "allowInterruptions",
  "preventFeedback",
];

function readinessDescriptionKey(
  inputReady: boolean,
  outputReady: boolean,
  backend: VoiceOutputBackend,
  inputBackend: VoiceInputBackend,
): string | null {
  if (inputReady && outputReady) return null;
  if (!inputReady && !outputReady) {
    if (inputBackend === "openai") {
      if (backend === "openai") return "voice.notReadyOpenAiSttAndTts";
      return backend === "siri"
        ? "voice.notReadyOpenAiSttAndSiriOutput"
        : "voice.notReadyOpenAiSttAndPocketOutput";
    }
    if (backend === "openai") {
      return inputBackend === "macos"
        ? "voice.notReadyMacInputAndOpenAiOutput"
        : "voice.notReadyInputAndOpenAiOutput";
    }
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
    if (inputBackend === "openai") return "voice.notReadyOpenAiStt";
    return inputBackend === "macos"
      ? "voice.notReadyMacInput"
      : "voice.notReadyInput";
  }
  if (backend === "openai") return "voice.notReadyOpenAiTts";
  return backend === "siri"
    ? "voice.notReadySiriOutput"
    : "voice.notReadyPocketOutput";
}

export function VoiceSettings() {
  const { t } = useTranslation("settings");
  const setup = usePocketVoiceSetup();
  const macSpeechSetup = useMacSpeechSetup();
  const { status: openAiStatus, error: openAiError } = useOpenAiVoiceSetup();
  const [openAiSpeed, setOpenAiSpeed] = useState(1);
  const [openAiSpeedError, setOpenAiSpeedError] = useState<string | null>(null);
  useEffect(() => {
    if (openAiStatus) setOpenAiSpeed(openAiStatus.playbackSpeed);
  }, [openAiStatus]);
  const input = useVoiceInputPreference(
    isMacSpeechAvailable(macSpeechSetup.status, macSpeechSetup.loading),
  );
  const output = useVoiceOutputPreference();
  const interruption = useVoiceInterruptionPreference();
  const siriSetup = useSiriVoiceSetup(output.backend === "siri");
  const siriSupported = getPlatform() === "mac";
  const microphonePermission = useMicrophonePermission(siriSupported);
  const inputHeadingId = useId();
  const inputDescriptionId = useId();
  const outputHeadingId = useId();
  const outputDescriptionId = useId();
  const interruptionHeadingId = useId();
  const interruptionDescriptionId = useId();
  const inputReady =
    input.backend === "openai"
      ? (openAiStatus?.sttConfigured ?? false)
      : input.backend === "macos"
        ? Boolean(
            macSpeechSetup.status?.supported &&
              macSpeechSetup.status.localeSupported &&
              macSpeechSetup.status.modelInstalled,
          )
        : (setup.status?.parakeetInstalled ?? false);
  const outputReady =
    output.backend === "openai"
      ? Boolean(openAiStatus?.ttsConfigured && openAiStatus.ttsAvailable)
      : output.backend === "siri"
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
      {microphonePermission.status === "denied" ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{t("voice.microphonePermissionTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("voice.microphonePermissionDenied")}</p>
            <Button
              type="button"
              variant="alert"
              size="sm"
              onClick={() => void microphonePermission.openSettings()}
            >
              {t("voice.openMicrophoneSettings")}
            </Button>
            {microphonePermission.openSettingsError ? (
              <p>{t("voice.openMicrophoneSettingsError")}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {readinessKey ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{t("voice.notReadyTitle")}</AlertTitle>
          <AlertDescription>{t(readinessKey)}</AlertDescription>
        </Alert>
      ) : null}
      <section className="space-y-2 overflow-hidden">
        <SettingsRow
          label={
            <h2 className="text-sm font-medium">{t("voice.speechInput")}</h2>
          }
          description={t("voice.inputBackendDescription")}
          labelId={inputHeadingId}
          descriptionId={inputDescriptionId}
          layout="responsive"
          action={({ labelId, descriptionId }) => (
            <Select
              value={input.backend ?? undefined}
              disabled={input.backend === null}
              onValueChange={(value) =>
                input.setBackend(value as VoiceInputBackend)
              }
            >
              <SelectTrigger
                className="w-full sm:w-auto"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              >
                <SelectValue placeholder={t("voice.macSpeechLoading")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parakeet">
                  {t("voice.backendParakeet")}
                </SelectItem>
                <SelectItem value="openai">
                  {t("voice.backendOpenAiStt")}
                </SelectItem>
                {macSpeechSetup.status?.supported &&
                macSpeechSetup.status.localeSupported ? (
                  <SelectItem value="macos">
                    {t("voice.backendMacSpeech")}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          )}
          details={
            input.backend === "openai" ? (
              <div className="space-y-2">
                <OpenAiApiKeyField
                  label={t("voice.openAiSttApiKey")}
                  configured={openAiStatus?.sttConfigured ?? false}
                  onSave={setOpenAiSttApiKey}
                  onClear={clearOpenAiSttApiKey}
                />
                <p className="text-xs text-muted-foreground">
                  {openAiError ??
                    openAiStatus?.sttUnavailableReason ??
                    (openAiStatus
                      ? openAiStatus.sttConfigured
                        ? t("voice.openAiSttConfigured", {
                            model: openAiStatus.transcriptionModel,
                          })
                        : t("voice.openAiSttNotConfigured")
                      : t("voice.openAiChecking"))}
                </p>
                {openAiStatus?.sttConfigurationSource === "environment" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("voice.openAiEnvironmentOverride")}
                  </p>
                ) : null}
              </div>
            ) : input.backend === "macos" ? (
              <MacSpeechSettings setup={macSpeechSetup} />
            ) : input.backend === "parakeet" ? (
              <PocketVoiceSetupContent
                setup={setup}
                models={["parakeet"]}
                showPocketVoiceControls={false}
              />
            ) : null
          }
        />
      </section>
      <section className="space-y-2">
        <SettingsRow
          label={
            <h2 className="text-sm font-medium">{t("voice.speechOutput")}</h2>
          }
          description={t("voice.outputBackendDescription")}
          labelId={outputHeadingId}
          descriptionId={outputDescriptionId}
          layout="responsive"
          action={({ labelId, descriptionId }) => (
            <Select
              value={output.backend}
              onValueChange={(value) =>
                output.setBackend(value as VoiceOutputBackend)
              }
            >
              <SelectTrigger
                className="w-full sm:w-auto"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pocket">
                  {t("voice.backendPocket")}
                </SelectItem>
                {openAiStatus?.ttsAvailable ? (
                  <SelectItem value="openai">
                    {t("voice.backendOpenAiTts")}
                  </SelectItem>
                ) : null}
                {siriSupported ? (
                  <SelectItem value="siri">{t("voice.backendSiri")}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          )}
          details={
            output.backend === "openai" ? (
              <div className="space-y-2">
                <OpenAiApiKeyField
                  label={t("voice.openAiTtsApiKey")}
                  configured={openAiStatus?.ttsConfigured ?? false}
                  onSave={setOpenAiTtsApiKey}
                  onClear={clearOpenAiTtsApiKey}
                />
                <p className="text-xs text-muted-foreground">
                  {openAiError ??
                    openAiStatus?.ttsUnavailableReason ??
                    (openAiStatus?.unavailableReason === "unsupportedPlatform"
                      ? t("voice.openAiTtsUnsupportedPlatform")
                      : openAiStatus?.unavailableReason === "missingApiKey"
                        ? t("voice.openAiTtsNeedsKey")
                        : openAiStatus
                          ? t("voice.openAiTtsConfigured", {
                              model: openAiStatus.speechModel,
                              voice: openAiStatus.speechVoice,
                            })
                          : t("voice.openAiChecking"))}
                </p>
                {openAiStatus?.ttsConfigurationSource === "environment" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("voice.openAiEnvironmentOverride")}
                  </p>
                ) : null}
                <PlaybackSpeedRow
                  speed={openAiSpeed}
                  speeds={[0.75, 1, 1.25, 1.5, 2]}
                  onChange={async (speed) => {
                    setOpenAiSpeedError(null);
                    try {
                      await setOpenAiPlaybackSpeed(speed);
                      setOpenAiSpeed(speed);
                    } catch (cause) {
                      setOpenAiSpeedError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    }
                  }}
                />
                {openAiSpeedError ? (
                  <p className="text-xs text-destructive" role="alert">
                    {openAiSpeedError}
                  </p>
                ) : null}
              </div>
            ) : output.backend === "siri" ? (
              <SiriVoiceSettings setup={siriSetup} />
            ) : (
              <PocketVoiceSetupContent setup={setup} models={["pocket"]} />
            )
          }
        />
      </section>
      <section className="space-y-4 py-4 pr-4">
        <h2 id={interruptionHeadingId} className="text-sm font-medium">
          {t("voice.interruptionMode")}
        </h2>
        <p
          id={interruptionDescriptionId}
          className="text-xs text-muted-foreground"
        >
          {t("voice.interruptionDescription")}
        </p>
        <RadioGroup
          value={interruption.mode}
          onValueChange={(value) =>
            interruption.setMode(value as VoiceInterruptionMode)
          }
          aria-labelledby={interruptionHeadingId}
          aria-describedby={interruptionDescriptionId}
          className="gap-2"
        >
          {INTERRUPTION_MODES.map((mode) => {
            const optionId = `${interruptionHeadingId}-${mode}`;
            return (
              <RadioGroupCard
                key={mode}
                id={optionId}
                value={mode}
                label={t(`voice.interruptionModes.${mode}`)}
                description={t(`voice.interruptionModeDescriptions.${mode}`)}
              />
            );
          })}
        </RadioGroup>
      </section>
    </SettingsPage>
  );
}
