import { ChevronRight, CircleAlert } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
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
  setOpenAiSpeechVoice,
  setOpenAiTtsApiKey,
} from "../api/openAiVoice";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { useMacSpeechSetup } from "../hooks/useMacSpeechSetup";
import { useMicrophonePermission } from "../hooks/useMicrophonePermission";
import { useSiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import {
  getDefaultVoiceInputBackend,
  isMacSpeechAvailable,
  useVoiceInputPreference,
} from "../lib/voiceInputPreference";
import type { VoiceInterruptionMode } from "../lib/voiceInterruptionPreference";
import {
  getDefaultVoiceInterruptionPreference,
  useVoiceInterruptionPreference,
} from "../lib/voiceInterruptionPreference";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import {
  getDefaultVoiceOutputBackend,
  useVoiceOutputPreference,
} from "../lib/voiceOutputPreference";
import type { VoiceConversationMode } from "../lib/voiceConversationModePreference";
import { useVoiceConversationModePreference } from "../lib/voiceConversationModePreference";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupContent";
import { MacSpeechSettings } from "./MacSpeechSettings";
import { SiriVoiceSettings } from "./SiriVoiceSettings";
import { PlaybackSpeedRow } from "./PlaybackSpeedRow";
import { SimpleVoicePickerDialog } from "./SimpleVoicePickerDialog";
import { useOpenAiVoiceSetup } from "../hooks/useOpenAiVoiceSetup";
import { OpenAiApiKeyField } from "./OpenAiApiKeyField";
import { RealtimeVoiceSettings } from "./RealtimeVoiceSettings";
import {
  getDefaultRealtimeVoicePreference,
  setRealtimeVoicePreference,
} from "../lib/realtimeVoicePreference";

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
  const [openAiSpeed, setOpenAiSpeed] = useState(1);
  const [openAiSpeedError, setOpenAiSpeedError] = useState<string | null>(null);
  const [openAiVoice, setOpenAiVoice] = useState("marin");
  const [openAiVoiceError, setOpenAiVoiceError] = useState<string | null>(null);
  const input = useVoiceInputPreference(
    isMacSpeechAvailable(macSpeechSetup.status, macSpeechSetup.loading),
  );
  const output = useVoiceOutputPreference();
  const { status: openAiStatus, error: openAiError } = useOpenAiVoiceSetup(
    input.backend === "openai" || output.backend === "openai",
  );
  useEffect(() => {
    if (openAiStatus) {
      setOpenAiSpeed(openAiStatus.playbackSpeed);
      setOpenAiVoice(openAiStatus.speechVoice);
    }
  }, [openAiStatus]);
  const interruption = useVoiceInterruptionPreference();
  const mode = useVoiceConversationModePreference();
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
  const openAiStatusLoaded =
    (input.backend !== "openai" && output.backend !== "openai") ||
    openAiStatus !== null ||
    openAiError !== null;
  const readinessKey =
    !pocketStatusLoaded || !openAiStatusLoaded
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

  const resetCurrentMode = () => {
    if (mode.mode === "openai-realtime") {
      setRealtimeVoicePreference(getDefaultRealtimeVoicePreference());
      return;
    }
    const macSpeechAvailable = Boolean(
      macSpeechSetup.status?.supported && macSpeechSetup.status.localeSupported,
    );
    input.setBackend(getDefaultVoiceInputBackend(macSpeechAvailable));
    output.setBackend(getDefaultVoiceOutputBackend());
    interruption.setMode(getDefaultVoiceInterruptionPreference().mode);
    if (getDefaultVoiceOutputBackend() === "siri") {
      void siriSetup.setPlaybackSpeed(1);
    }
  };

  return (
    <SettingsPage
      title={t("nav.voice")}
      description={t("voice.settingsDescription")}
      contentClassName="space-y-4"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={resetCurrentMode}
          title={t("voice.resetToDefaultsDescription")}
        >
          {t(
            mode.mode === "openai-realtime"
              ? "voice.resetExpertSettings"
              : "voice.resetChainedSettings",
          )}
        </Button>
      }
    >
      <section className="space-y-3 overflow-hidden">
        <div>
          <h2 className="text-sm font-medium">{t("voice.conversationMode")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("voice.conversationModeDescription")}
          </p>
        </div>
        <RadioGroup
          value={mode.mode}
          onValueChange={(value) =>
            mode.setMode(value as VoiceConversationMode)
          }
          className="grid gap-2 sm:grid-cols-2"
          aria-label={t("voice.conversationMode")}
        >
          <RadioGroupCard
            id="voice-mode-chained"
            value="chained"
            label={t("voice.modeChained")}
            description={t("voice.modeChainedDescription")}
          />
          <RadioGroupCard
            id="voice-mode-openai-realtime"
            value="openai-realtime"
            label={t("voice.modeOpenAiRealtime")}
            description={t("voice.modeOpenAiRealtimeDescription")}
          />
        </RadioGroup>
      </section>
      {mode.mode === "chained" ? (
        <>
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
              className="py-2"
              label={
                <h2 className="text-sm font-medium">
                  {t("voice.speechInput")}
                </h2>
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
                        <span className="flex items-center gap-2">
                          {t("voice.backendMacSpeech")}
                          <Badge variant="secondary">
                            {t("voice.recommended")}
                          </Badge>
                        </span>
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
              className="py-2"
              label={
                <h2 className="text-sm font-medium">
                  {t("voice.speechOutput")}
                </h2>
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
                    {getPlatform() === "mac" ? (
                      <SelectItem value="openai">
                        {t("voice.backendOpenAiTts")}
                      </SelectItem>
                    ) : null}
                    {siriSupported ? (
                      <SelectItem value="siri">
                        <span className="flex items-center gap-2">
                          {t("voice.backendSiri")}
                          <Badge variant="secondary">
                            {t("voice.recommended")}
                          </Badge>
                        </span>
                      </SelectItem>
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
                        (openAiStatus?.unavailableReason ===
                        "unsupportedPlatform"
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
                    <div className="divide-y divide-border">
                      <SimpleVoicePickerDialog
                        options={(
                          openAiStatus?.speechVoices ?? [openAiVoice]
                        ).map((voice) => ({
                          value: voice,
                          label:
                            voice === "marin"
                              ? t("voice.defaultOption", {
                                  value: `${voice.charAt(0).toUpperCase()}${voice.slice(1)}`,
                                })
                              : `${voice.charAt(0).toUpperCase()}${voice.slice(1)}`,
                        }))}
                        selectedVoice={openAiVoice}
                        error={openAiVoiceError}
                        onChange={async (voice) => {
                          setOpenAiVoiceError(null);
                          try {
                            await setOpenAiSpeechVoice(voice);
                            setOpenAiVoice(voice);
                          } catch (cause) {
                            setOpenAiVoiceError(
                              cause instanceof Error
                                ? cause.message
                                : String(cause),
                            );
                          }
                        }}
                      />
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
                              cause instanceof Error
                                ? cause.message
                                : String(cause),
                            );
                          }
                        }}
                      />
                    </div>
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
          <section className="space-y-2 overflow-hidden">
            <SettingsRow
              className="py-2"
              label={
                <h2 id={interruptionHeadingId} className="text-sm font-medium">
                  {t("voice.interruptionMode")}
                </h2>
              }
              description={t("voice.interruptionDescription")}
              descriptionId={interruptionDescriptionId}
              layout="responsive"
              action={({ labelId, descriptionId }) => (
                <Select
                  value={interruption.mode}
                  onValueChange={(value) =>
                    interruption.setMode(value as VoiceInterruptionMode)
                  }
                >
                  <SelectTrigger
                    className="w-full sm:w-60"
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERRUPTION_MODES.map((interruptionMode) => (
                      <SelectItem
                        key={interruptionMode}
                        value={interruptionMode}
                      >
                        {t(`voice.interruptionModes.${interruptionMode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="group px-0">
                  <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
                  {t("voice.advanced")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                {INTERRUPTION_MODES.map((interruptionMode) => (
                  <div
                    key={interruptionMode}
                    className="rounded-md border px-3 py-2"
                  >
                    <p className="text-sm font-medium">
                      {t(`voice.interruptionModes.${interruptionMode}`)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        `voice.interruptionModeDescriptions.${interruptionMode}`,
                      )}
                    </p>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </section>
        </>
      ) : (
        <RealtimeVoiceSettings />
      )}
    </SettingsPage>
  );
}
