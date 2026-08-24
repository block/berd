import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  sensitivity: "balanced" as "less" | "balanced" | "more",
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
    setSensitivity: vi.fn(),
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
  beforeEach(() => {
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
    interruptionState.sensitivity = "balanced";
    siriSetupState.current = siriSetup();
  });

  it("shows sensitivity for automatic and allow-interruptions modes", () => {
    setupState.current = setup(pocketStatus());
    const view = renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByRole("radiogroup", { name: "While Berd is speaking" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked();
    expect(
      screen.getByText(
        "Allows interruptions on most audio devices. If the device name contains “speaker,” Berd pauses listening to prevent feedback.",
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
      screen.getByRole("combobox", { name: "Interruption sensitivity" }),
    ).toHaveAccessibleDescription(
      "Choose how easily your voice interrupts Berd while it is speaking.",
    );

    interruptionState.mode = "allowInterruptions";
    view.rerender(<VoiceSettings />);
    expect(
      screen.getByRole("combobox", { name: "Interruption sensitivity" }),
    ).toBeInTheDocument();
  });

  it("hides sensitivity when feedback prevention disables interruptions", () => {
    setupState.current = setup(pocketStatus());
    interruptionState.mode = "preventFeedback";
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByRole("radio", { name: /^Prevent feedback/ }),
    ).toBeChecked();
    expect(
      screen.queryByRole("combobox", { name: "Interruption sensitivity" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Earshot sensitivity available for macOS speech input", () => {
    setupState.current = setup(pocketStatus());
    inputState.backend = "macos";
    renderWithProviders(<VoiceSettings />);

    expect(
      screen.getByRole("radiogroup", { name: "While Berd is speaking" }),
    ).toBeInTheDocument();
    const sensitivity = screen.getByRole("combobox", {
      name: "Interruption sensitivity",
    });
    expect(sensitivity).toBeEnabled();
    expect(sensitivity).toHaveAccessibleDescription(
      "Choose how easily your voice interrupts Berd while it is speaking.",
    );
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
        ?.parentElement,
    ).toHaveClass("flex-col", "sm:flex-row");
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
      "pr-4",
      "py-4",
    );
    expect(screen.getByTestId("voice-model-pocket")).not.toHaveClass(
      "pl-4",
      "px-4",
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

    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText(/173.8 MB on disk/)).toBeInTheDocument();
    expect(screen.getByText(/131.7 MB on disk/)).toBeInTheDocument();
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
