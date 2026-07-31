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
