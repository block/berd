import { CircleAlert } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
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
import { resetAllVoiceBackendSettings } from "../api/voiceSettings";
import { usePocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { useMacSpeechSetup } from "../hooks/useMacSpeechSetup";
import { useMicrophonePermission } from "../hooks/useMicrophonePermission";
import { useSiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { StatusSoundMode } from "../lib/statusSoundPreference";
import {
  getDefaultStatusSoundPreference,
  useStatusSoundPreference,
} from "../lib/statusSoundPreference";
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
import {
  getDefaultVoiceConversationMode,
  useVoiceConversationModePreference,
} from "../lib/voiceConversationModePreference";
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
import {
  DEFAULT_OPENAI_VOICE,
  openAiVoiceOptions,
} from "../lib/openAiVoiceOptions";

const STATUS_SOUND_MODES: StatusSoundMode[] = [
  "off",
  "working",
  "working-and-waiting",
];

const INTERRUPTION_MODES: VoiceInterruptionMode[] = [
  "automatic",
  "allowInterruptions",
  "preventFeedback",
];

function BackendOption({
  label,
  location,
  recommended = false,
}: {
  label: string;
  location: string;
  recommended?: boolean;
}) {
  const { t } = useTranslation("settings");

  return (
    <span className="flex items-center gap-2">
      {label}
      {recommended ? (
        <Badge variant="secondary">{t("voice.recommended")}</Badge>
      ) : null}
      <Badge variant="outline">{location}</Badge>
    </span>
  );
}

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
  const [openAiVoice, setOpenAiVoice] = useState(DEFAULT_OPENAI_VOICE);
  const [openAiVoiceError, setOpenAiVoiceError] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
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
  const statusSounds = useStatusSoundPreference();
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

  const resetAllVoiceSettings = async () => {
    const macSpeechAvailable = Boolean(
      macSpeechSetup.status?.supported && macSpeechSetup.status.localeSupported,
    );
    setResetting(true);
    setResetError(null);
    try {
      await resetAllVoiceBackendSettings();
      await setup.refreshSettings();
      await siriSetup.refreshSettings();
      setRealtimeVoicePreference(getDefaultRealtimeVoicePreference());
      input.setBackend(getDefaultVoiceInputBackend(macSpeechAvailable));
      output.setBackend(getDefaultVoiceOutputBackend());
      interruption.setMode(getDefaultVoiceInterruptionPreference().mode);
      mode.setMode(getDefaultVoiceConversationMode());
      statusSounds.update(getDefaultStatusSoundPreference());
      setResetDialogOpen(false);
    } finally {
      setResetting(false);
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
          onClick={() => {
            setResetError(null);
            setResetDialogOpen(true);
          }}
          title={t("voice.resetToDefaultsDescription")}
          disabled={macSpeechSetup.loading}
        >
          {t("voice.resetToDefaults")}
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
            label={
              <span className="flex items-center gap-2">
                {t("voice.modeOpenAiRealtime")}
                <Badge variant="outline">{t("voice.cloud")}</Badge>
              </span>
            }
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
                      <BackendOption
                        label={t("voice.backendParakeet")}
                        location={t("voice.local")}
                      />
                    </SelectItem>
                    <SelectItem value="openai">
                      <BackendOption
                        label={t("voice.backendOpenAiStt")}
                        location={t("voice.cloud")}
                      />
                    </SelectItem>
                    {macSpeechSetup.status?.supported &&
                    macSpeechSetup.status.localeSupported ? (
                      <SelectItem value="macos">
                        <BackendOption
                          label={t("voice.backendMacSpeech")}
                          location={t("voice.local")}
                          recommended
                        />
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
                      <BackendOption
                        label={t("voice.backendPocket")}
                        location={t("voice.local")}
                      />
                    </SelectItem>
                    {getPlatform() === "mac" ? (
                      <SelectItem value="openai">
                        <BackendOption
                          label={t("voice.backendOpenAiTts")}
                          location={t("voice.cloud")}
                        />
                      </SelectItem>
                    ) : null}
                    {siriSupported ? (
                      <SelectItem value="siri">
                        <BackendOption
                          label={t("voice.backendSiri")}
                          location={t("voice.local")}
                          recommended
                        />
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
                        options={openAiVoiceOptions(
                          openAiStatus?.speechVoices ?? [openAiVoice],
                        )}
                        selectedVoice={openAiVoice}
                        defaultVoice={DEFAULT_OPENAI_VOICE}
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
              description={t(
                `voice.interruptionModeDescriptions.${interruption.mode}`,
              )}
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
          </section>
        </>
      ) : (
        <RealtimeVoiceSettings />
      )}
      <section className="space-y-2 overflow-hidden">
        <SettingsRow
          className="py-2"
          label={
            <h2 className="text-sm font-medium">{t("voice.statusSounds")}</h2>
          }
          description={t(
            `voice.statusSoundModeDescriptions.${statusSounds.mode}`,
          )}
          layout="responsive"
          action={({ labelId, descriptionId }) => (
            <Select
              value={statusSounds.mode}
              onValueChange={(value) =>
                statusSounds.update({ mode: value as StatusSoundMode })
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
                {STATUS_SOUND_MODES.map((statusSoundMode) => (
                  <SelectItem key={statusSoundMode} value={statusSoundMode}>
                    {t(`voice.statusSoundModes.${statusSoundMode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </section>
      {resetError ? (
        <p className="text-sm text-destructive" role="alert">
          {resetError}
        </p>
      ) : null}
      <ConfirmDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        title={t("voice.resetToDefaultsConfirmTitle")}
        description={t("voice.resetToDefaultsConfirmDescription")}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("voice.resetToDefaults")}
        loadingLabel={t("voice.resettingToDefaults")}
        isLoading={resetting}
        destructive={false}
        onConfirm={resetAllVoiceSettings}
        onConfirmError={(error) => {
          setResetError(error instanceof Error ? error.message : String(error));
          setResetDialogOpen(false);
        }}
      />
    </SettingsPage>
  );
}
