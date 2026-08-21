import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { PocketVoiceSetup } from "../hooks/usePocketVoiceSetup";
import { VoiceSettings } from "./VoiceSettings";

const setupState = vi.hoisted(() => ({
  current: null as PocketVoiceSetup | null,
}));

vi.mock("../hooks/usePocketVoiceSetup", () => ({
  usePocketVoiceSetup: () => setupState.current,
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

describe("VoiceSettings", () => {
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
});
