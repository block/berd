import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { PocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import type { MacSpeechSetup } from "../hooks/useMacSpeechSetup";
import type { SiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import { VoiceSettings } from "./VoiceSettings";

const setupState = vi.hoisted(() => ({
  current: null as PocketVoiceSetup | null,
}));
const siriSetupState = vi.hoisted(() => ({
  current: null as SiriVoiceSetup | null,
}));
const macSpeechSetupState = vi.hoisted(() => ({
  current: {
    status: {
      supported: false,
      unavailableReason: "Apple speech recognition is unavailable.",
      locale: "",
      localeSupported: false,
      modelInstalled: false,
      installing: false,
      progress: null,
      error: null,
      revision: 0,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    install: vi.fn(),
  } as MacSpeechSetup,
}));
const inputState = vi.hoisted(() => ({
  backend: "parakeet" as VoiceInputBackend,
}));
const outputState = vi.hoisted(() => ({
  backend: "pocket" as VoiceOutputBackend,
}));
const interruptionState = vi.hoisted(() => ({
  mode: "automatic" as "automatic" | "allowInterruptions" | "preventFeedback",
}));
const microphonePermissionState = vi.hoisted(() => ({
  status: "authorized" as "notDetermined" | "denied" | "authorized" | "unknown",
  openSettingsError: false,
  openSettings: vi.fn(),
}));
const openAiStatusState = vi.hoisted(() => ({
  current: {
    sttConfigured: true,
    ttsConfigured: true,
    sttConfigurationSource: "default" as "default" | "environment",
    ttsConfigurationSource: "default" as "default" | "environment",
    sttUnavailableReason: null,
    ttsUnavailableReason: null,
    transcriptionModel: "gpt-live-transcribe",
    speechModel: "gpt-4o-mini-tts",
    speechVoice: "marin",
    playbackSpeed: 1,
    ttsAvailable: true,
    unavailableReason: null as string | null,
  },
}));
const openAiApiMocks = vi.hoisted(() => ({
  setSttApiKey: vi.fn(() => Promise.resolve()),
  clearSttApiKey: vi.fn(() => Promise.resolve()),
  setTtsApiKey: vi.fn(() => Promise.resolve()),
  clearTtsApiKey: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api/openAiVoice", () => ({
  setOpenAiPlaybackSpeed: vi.fn(() => Promise.resolve()),
  setOpenAiSttApiKey: openAiApiMocks.setSttApiKey,
  clearOpenAiSttApiKey: openAiApiMocks.clearSttApiKey,
  setOpenAiTtsApiKey: openAiApiMocks.setTtsApiKey,
  clearOpenAiTtsApiKey: openAiApiMocks.clearTtsApiKey,
}));
vi.mock("../hooks/useOpenAiVoiceSetup", () => ({
  useOpenAiVoiceSetup: () => ({
    status: openAiStatusState.current,
    error: null,
  }),
}));
vi.mock("../hooks/usePocketVoiceSetup", () => ({
  usePocketVoiceSetup: () => setupState.current,
}));
vi.mock("../hooks/useMacSpeechSetup", () => ({
  useMacSpeechSetup: () => macSpeechSetupState.current,
}));
vi.mock("../hooks/useSiriVoiceSetup", () => ({
  useSiriVoiceSetup: () => siriSetupState.current,
  voiceKey: (voice: { name: string; language: string }) =>
    `${voice.name.toLowerCase()}|${voice.language.toLowerCase()}`,
}));
vi.mock("../hooks/useMicrophonePermission", () => ({
  useMicrophonePermission: () => microphonePermissionState,
}));
vi.mock("../lib/voiceOutputPreference", () => ({
  useVoiceOutputPreference: () => ({
    backend: outputState.backend,
    setBackend: vi.fn(),
  }),
}));
vi.mock("../lib/voiceInputPreference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/voiceInputPreference")>()),
  useVoiceInputPreference: () => ({
    backend: inputState.backend,
    setBackend: vi.fn(),
  }),
}));
vi.mock("../lib/voiceInterruptionPreference", () => ({
  useVoiceInterruptionPreference: () => ({
    ...interruptionState,
    setMode: vi.fn(),
  }),
}));

function setup(status: PocketVoiceStatus): PocketVoiceSetup {
  return {
    status,
    loading: false,
    error: null,
    previewingVoiceId: null,
    removingModel: null,
    installModel: vi.fn(),
    previewVoice: vi.fn(),
    selectVoice: vi.fn(),
    setPlaybackSpeed: vi.fn(),
    removeModel: vi.fn(),
  };
}

function pocketStatus(
  overrides: Partial<PocketVoiceStatus> = {},
): PocketVoiceStatus {
  return {
    statusRevision: 0,
    installed: false,
    pocketInstalled: false,
    parakeetInstalled: false,
    pocketSizeBytes: null,
    parakeetSizeBytes: null,
    pocketDownloadBytes: 0,
    parakeetDownloadBytes: 104_337_827,
    downloading: false,
    activeModel: null,
    pocketAttemptId: null,
    parakeetAttemptId: null,
    pocketProgress: null,
    parakeetProgress: null,
    pocketError: null,
    parakeetError: null,
    removing: null,
    removalQueued: false,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
    selectedVoice: "mary",
    playbackSpeed: 1,
    voices: [],
    ...overrides,
  };
}

function siriSetup(): SiriVoiceSetup {
  return {
    status: {
      supported: true,
      availableLanguages: ["en-US"],
      selectedVoice: { name: "Nora", language: "en-US" },
      selectedVoiceInstalled: true,
      playbackSpeed: 1,
      voices: [
        {
          name: "Nora",
          language: "en-US",
          sizeBytes: 0,
          installed: true,
        },
      ],
    },
    language: "en-US",
    languages: ["en-US"],
    loading: false,
    error: null,
    statusError: null,
    downloadingVoiceKey: null,
    previewingVoiceKey: null,
    setLanguage: vi.fn(),
    setPlaybackSpeed: vi.fn(),
    downloadVoice: vi.fn(),
    previewVoice: vi.fn(),
    selectVoice: vi.fn(),
  };
}

describe("VoiceSettings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    microphonePermissionState.status = "authorized";
    microphonePermissionState.openSettingsError = false;
    microphonePermissionState.openSettings.mockReset();
    inputState.backend = "parakeet";
    outputState.backend = "pocket";
    macSpeechSetupState.current = {
      status: {
        supported: false,
        unavailableReason: "Apple speech recognition is unavailable.",
        locale: "en-US",
        localeSupported: false,
        modelInstalled: false,
        installing: false,
        progress: null,
        error: null,
        revision: 0,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      install: vi.fn(),
    };
    interruptionState.mode = "automatic";
    siriSetupState.current = siriSetup();
    openAiStatusState.current = {
      sttConfigured: true,
      ttsConfigured: true,
      sttConfigurationSource: "default",
      ttsConfigurationSource: "default",
      sttUnavailableReason: null,
      ttsUnavailableReason: null,
      transcriptionModel: "gpt-live-transcribe",
      speechModel: "gpt-4o-mini-tts",
      speechVoice: "marin",
      playbackSpeed: 1,
      ttsAvailable: true,
      unavailableReason: null,
    };
    openAiApiMocks.setTtsApiKey.mockClear();
    openAiApiMocks.clearTtsApiKey.mockClear();
    openAiApiMocks.setSttApiKey.mockClear();
    openAiApiMocks.clearSttApiKey.mockClear();
  });

  it("renders independently selected OpenAI input and output settings", async () => {
    inputState.backend = "openai";
    outputState.backend = "openai";
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText("Uses gpt-live-transcribe."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/gpt-4o-mini-tts.*marin voice/),
    ).toBeInTheDocument();
    expect(screen.getByText("Playback speed")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Saved securely and shared by OpenAI transcription and voice playback.",
      ),
    ).toHaveLength(2);
  });

  it("saves the shared OpenAI voice key from the speech-to-text settings", async () => {
    inputState.backend = "openai";
    setupState.current = setup(pocketStatus({ pocketInstalled: true }));
    renderWithProviders(<VoiceSettings />);

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("OpenAI speech-to-text API key"),
      "stt-secret",
    );
    await user.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    expect(openAiApiMocks.setSttApiKey).toHaveBeenCalledWith("stt-secret");
  });

  it("labels purpose-specific environment overrides", async () => {
    outputState.backend = "openai";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      ttsConfigurationSource: "environment",
    };
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "Development configuration is overridden by the Berd process environment.",
      ),
    ).toBeInTheDocument();
  });

  it("labels speech-to-text environment overrides", async () => {
    inputState.backend = "openai";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      sttConfigurationSource: "environment",
    };
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "Development configuration is overridden by the Berd process environment.",
      ),
    ).toBeInTheDocument();
  });

  it("saves the shared OpenAI voice key from the text-to-speech settings", async () => {
    outputState.backend = "openai";
    setupState.current = setup(pocketStatus({ parakeetInstalled: true }));
    renderWithProviders(<VoiceSettings />);

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("OpenAI text-to-speech API key"),
      "tts-secret",
    );
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(openAiApiMocks.setTtsApiKey).toHaveBeenCalledWith("tts-secret");
  });

  it("uses OpenAI guidance when only the selected OpenAI input is not ready", async () => {
    inputState.backend = "openai";
    outputState.backend = "pocket";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      sttConfigured: false,
    };
    setupState.current = setup(pocketStatus({ pocketInstalled: true }));
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "OpenAI transcription is not ready. Add the shared OpenAI voice API key below, then try again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Parakeet STT is not installed/),
    ).not.toBeInTheDocument();
  });

  it("reports missing OpenAI input and Pocket output together", async () => {
    inputState.backend = "openai";
    outputState.backend = "pocket";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      sttConfigured: false,
    };
    setupState.current = setup(pocketStatus({ pocketInstalled: false }));

    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "The shared OpenAI voice API key is missing, and Pocket TTS is not installed. Complete both steps below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
  });

  it("reports missing OpenAI input and Siri output together", async () => {
    inputState.backend = "openai";
    outputState.backend = "siri";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      sttConfigured: false,
    };
    const current = siriSetup();
    siriSetupState.current = {
      ...current,
      status: current.status
        ? {
            ...current.status,
            selectedVoice: null,
            selectedVoiceInstalled: false,
          }
        : null,
    };

    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "The shared OpenAI voice API key is missing, and no installed Siri voice is selected. Complete both steps below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
  });

  it("does not show the TTS platform restriction for configured OpenAI input", async () => {
    inputState.backend = "openai";
    outputState.backend = "pocket";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      ttsAvailable: false,
      unavailableReason: "unsupportedPlatform",
    };
    setupState.current = setup(pocketStatus({ pocketInstalled: true }));
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText("Uses gpt-live-transcribe."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/playback is currently supported on macOS only/),
    ).not.toBeInTheDocument();
  });

  it("uses OpenAI guidance when the selected OpenAI output is not ready", async () => {
    outputState.backend = "openai";
    openAiStatusState.current = {
      ...openAiStatusState.current,
      ttsConfigured: false,
    };
    setupState.current = setup(pocketStatus({ parakeetInstalled: true }));
    renderWithProviders(<VoiceSettings />);

    expect(
      await screen.findByText(
        "OpenAI voice playback is not ready. Add the shared OpenAI voice API key below, then try again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Pocket TTS is not installed/),
    ).not.toBeInTheDocument();
  });

  it("shows interruption modes without VAD controls", () => {
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByRole("radiogroup", { name: "Interruptions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose what happens when you speak while Berd is talking.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked();
    expect(
      screen.getByText(
        "Allows interruptions on most audio devices. Berd pauses listening on built-in Mac speakers or when the device name contains “speaker” or “altavoces.”",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Berd keeps listening on every audio device. You can interrupt, but speaker audio may be mistaken for your voice.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Berd pauses listening on every audio device. This prevents feedback, but you can’t interrupt.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Interruption sensitivity"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Advanced…" }),
    ).not.toBeInTheDocument();
  });

  it("does not warn before macOS has requested microphone access", () => {
    microphonePermissionState.status = "notDetermined";
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.queryByRole("button", { name: "Open Microphone Settings" }),
    ).not.toBeInTheDocument();
  });

  it("opens macOS settings when microphone access was denied", async () => {
    microphonePermissionState.status = "denied";
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByText(/Microphone access is turned off for Berd/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open Microphone Settings" }),
    );

    expect(microphonePermissionState.openSettings).toHaveBeenCalledOnce();
  });

  it("shows localized guidance when microphone settings cannot open", () => {
    microphonePermissionState.status = "denied";
    microphonePermissionState.openSettingsError = true;
    setupState.current = setup(pocketStatus());
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByText(/Couldn't open Microphone Settings/),
    ).toBeInTheDocument();
  });

  it("uses one accessible speech output heading for the backend picker", () => {
    setupState.current = setup({
      statusRevision: 0,
      installed: false,
      pocketInstalled: false,
      parakeetInstalled: false,
      pocketSizeBytes: null,
      parakeetSizeBytes: null,
      pocketDownloadBytes: 0,
      parakeetDownloadBytes: 0,
      downloading: false,
      activeModel: null,
      pocketAttemptId: null,
      parakeetAttemptId: null,
      pocketProgress: null,
      parakeetProgress: null,
      pocketError: null,
      parakeetError: null,
      removing: null,
      removalQueued: false,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      selectedVoice: "mary",
      playbackSpeed: 1,
      voices: [],
    });
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByRole("heading", { name: "Speech output" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Speech engine")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Speech output" }),
    ).toHaveAccessibleDescription(
      "Choose how Berd speaks assistant responses.",
    );
    const outputPicker = screen.getByRole("combobox", {
      name: "Speech output",
    });
    expect(outputPicker).toHaveClass("w-full", "sm:w-auto");
    expect(
      screen.getByRole("heading", { name: "Speech output" }).parentElement
        ?.parentElement?.parentElement,
    ).toHaveClass("flex-col", "sm:flex-row");
    expect(screen.getAllByText("Pocket TTS")).toHaveLength(1);
    expect(screen.getAllByText("Parakeet STT")).toHaveLength(1);
  });

  it("keeps the Voice settings page open while Parakeet completes in place", () => {
    const missing: PocketVoiceStatus = {
      statusRevision: 4,
      installed: false,
      pocketInstalled: true,
      parakeetInstalled: false,
      pocketSizeBytes: 173_782_737,
      parakeetSizeBytes: null,
      pocketDownloadBytes: 173_782_737,
      parakeetDownloadBytes: 104_337_827,
      downloading: true,
      activeModel: "parakeet",
      pocketAttemptId: null,
      parakeetAttemptId: 4,
      pocketProgress: null,
      parakeetProgress: {
        attemptId: 4,
        downloadedBytes: 104_337_827,
        totalBytes: 104_337_827,
        phase: "extracting",
      },
      pocketError: null,
      parakeetError: null,
      removing: null,
      removalQueued: false,
      downloadedBytes: 104_337_827,
      totalBytes: 104_337_827,
      error: null,
      selectedVoice: "mary",
      playbackSpeed: 1,
      voices: [],
    };
    setupState.current = setup(missing);
    const view = renderWithProviders(<VoiceSettings />);

    expect(screen.getByText("Preparing model")).toBeInTheDocument();
    const modelList = screen.getByTestId("voice-model-pocket").parentElement;
    expect(modelList).toHaveClass("divide-y", "divide-border");
    expect(modelList).not.toHaveClass("border", "rounded-md");
    expect(screen.getByTestId("voice-model-pocket")).toHaveClass(
      "py-2.5",
      "pl-3.5",
      "bg-muted/40",
    );
    expect(screen.getByTestId("voice-model-pocket")).not.toHaveTextContent(
      "Pocket TTS",
    );

    setupState.current = setup({
      ...missing,
      installed: true,
      parakeetInstalled: true,
      parakeetSizeBytes: 131_662_414,
      downloading: false,
      activeModel: null,
      parakeetProgress: {
        attemptId: 4,
        downloadedBytes: 104_337_827,
        totalBytes: 104_337_827,
        phase: "complete",
      },
      downloadedBytes: 0,
      totalBytes: 0,
    });
    view.rerender(<VoiceSettings />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Voice" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/173.8 MB · Installed/)).toBeInTheDocument();
    expect(screen.getByText(/131.7 MB · Installed/)).toBeInTheDocument();
    expect(screen.queryByText("Preparing model")).not.toBeInTheDocument();
  });

  it("explains when missing speech input blocks Voice Conversation", () => {
    outputState.backend = "siri";
    siriSetupState.current = siriSetup();
    setupState.current = setup({
      statusRevision: 0,
      installed: false,
      pocketInstalled: false,
      parakeetInstalled: false,
      pocketSizeBytes: null,
      parakeetSizeBytes: null,
      pocketDownloadBytes: 0,
      parakeetDownloadBytes: 104_337_827,
      downloading: false,
      activeModel: null,
      pocketAttemptId: null,
      parakeetAttemptId: null,
      pocketProgress: null,
      parakeetProgress: null,
      pocketError: null,
      parakeetError: null,
      removing: null,
      removalQueued: false,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      selectedVoice: "mary",
      playbackSpeed: 1,
      voices: [],
    });

    renderWithProviders(<VoiceSettings />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Voice Conversation isn't ready",
    );
    expect(
      screen.getByText(
        "Parakeet STT is not installed. Download it below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
  });

  it("does not diagnose a Siri load failure as a missing selection", () => {
    outputState.backend = "siri";
    const staleSiriSetup = siriSetup();
    siriSetupState.current = {
      ...staleSiriSetup,
      status: staleSiriSetup.status
        ? {
            ...staleSiriSetup.status,
            selectedVoice: null,
            selectedVoiceInstalled: false,
          }
        : null,
      error: "Siri voice catalog unavailable",
      statusError: "Siri voice catalog unavailable",
    };
    setupState.current = setup(
      pocketStatus({
        installed: true,
        parakeetInstalled: true,
        parakeetSizeBytes: 131_662_414,
        parakeetDownloadBytes: 0,
      }),
    );

    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByText("Siri voice catalog unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No installed Siri voice is selected/),
    ).not.toBeInTheDocument();
  });

  it("keeps readiness guidance visible for a Siri action error", () => {
    outputState.backend = "siri";
    const current = siriSetup();
    siriSetupState.current = {
      ...current,
      status: current.status
        ? {
            ...current.status,
            selectedVoice: null,
            selectedVoiceInstalled: false,
          }
        : null,
      error: "Preview failed",
      statusError: null,
    };

    renderWithProviders(<VoiceSettings />);

    expect(screen.getByText("Preview failed")).toBeInTheDocument();
    expect(
      screen.getByText(/No installed Siri voice is selected/),
    ).toBeInTheDocument();
  });

  it("still explains missing speech input while Siri status is unavailable", () => {
    outputState.backend = "siri";
    siriSetupState.current = {
      ...siriSetup(),
      status: null,
      error: "Siri voice catalog unavailable",
      statusError: "Siri voice catalog unavailable",
    };
    setupState.current = setup(
      pocketStatus({
        installed: false,
        parakeetInstalled: false,
      }),
    );

    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByText(
        "Parakeet STT is not installed. Download it below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No installed Siri voice is selected/),
    ).not.toBeInTheDocument();
  });

  it("identifies native macOS input while Siri status is unresolved", () => {
    inputState.backend = "macos";
    outputState.backend = "siri";
    siriSetupState.current = {
      ...siriSetup(),
      status: null,
      error: null,
      statusError: null,
      loading: true,
    };
    macSpeechSetupState.current = {
      status: {
        supported: true,
        unavailableReason: null,
        locale: "en-US",
        localeSupported: true,
        modelInstalled: false,
        installing: false,
        progress: null,
        error: null,
        revision: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      install: vi.fn(),
    };
    setupState.current = setup(pocketStatus());

    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByText(
        "Apple's on-device dictation model is not installed. Download it below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Parakeet STT is not installed/),
    ).not.toBeInTheDocument();
  });

  it("offers the on-device dictation download for native macOS input", () => {
    inputState.backend = "macos";
    setupState.current = setup(pocketStatus({ pocketInstalled: true }));
    macSpeechSetupState.current = {
      status: {
        supported: true,
        unavailableReason: null,
        locale: "en-US",
        localeSupported: true,
        modelInstalled: false,
        installing: false,
        progress: null,
        error: null,
        revision: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      install: vi.fn(),
    };

    renderWithProviders(<VoiceSettings />);

    expect(screen.getByText("On-device dictation")).toBeInTheDocument();
    expect(screen.getByText("Not installed for en-US")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Apple's on-device dictation model is not installed. Download it below to use Voice Conversation.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download model" }),
    ).toBeEnabled();
  });

  it("hides Apple speech model details when speech recognition is ready", () => {
    inputState.backend = "macos";
    setupState.current = setup(pocketStatus({ pocketInstalled: true }));
    macSpeechSetupState.current = {
      status: {
        supported: true,
        unavailableReason: null,
        locale: "en-CA",
        localeSupported: true,
        modelInstalled: true,
        installing: false,
        progress: null,
        error: null,
        revision: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      install: vi.fn(),
    };

    renderWithProviders(<VoiceSettings />);

    expect(screen.queryByText("On-device dictation")).not.toBeInTheDocument();
    expect(screen.queryByText("Installed for en-CA")).not.toBeInTheDocument();
  });
});
