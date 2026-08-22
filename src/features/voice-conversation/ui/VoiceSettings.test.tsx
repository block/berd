import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { PocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import type { SiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";
import { VoiceSettings } from "./VoiceSettings";

const setupState = vi.hoisted(() => ({
  current: null as PocketVoiceSetup | null,
}));
const siriSetupState = vi.hoisted(() => ({
  current: null as SiriVoiceSetup | null,
}));
const outputState = vi.hoisted(() => ({
  backend: "pocket" as VoiceOutputBackend,
}));

vi.mock("../hooks/usePocketVoiceSetup", () => ({
  usePocketVoiceSetup: () => setupState.current,
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
    outputState.backend = "pocket";
    siriSetupState.current = siriSetup();
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

  it("still explains missing speech input while Siri status is unavailable", () => {
    outputState.backend = "siri";
    siriSetupState.current = {
      ...siriSetup(),
      status: null,
      error: "Siri voice catalog unavailable",
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
});
