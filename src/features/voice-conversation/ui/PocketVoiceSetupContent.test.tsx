import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { PocketVoiceSetupContent } from "./PocketVoiceSetupContent";
import type { PocketVoiceStatus } from "../api/pocketVoice";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

describe("PocketVoiceSetupContent", () => {
  const baseStatus: PocketVoiceStatus = {
    statusRevision: 0,
    installed: false,
    pocketInstalled: false,
    parakeetInstalled: false,
    pocketSizeBytes: null,
    parakeetSizeBytes: null,
    pocketDownloadBytes: 173_782_737,
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
  };

  const setup = (
    status: PocketVoiceStatus,
    overrides: Partial<
      ComponentProps<typeof PocketVoiceSetupContent>["setup"]
    > = {},
  ): ComponentProps<typeof PocketVoiceSetupContent>["setup"] => ({
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
    ...overrides,
  });

  it("keeps both missing model actions independently clickable", async () => {
    const installModel = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <PocketVoiceSetupContent setup={setup(baseStatus, { installModel })} />,
    );

    expect(screen.getByText(/173.8 MB download/)).toBeInTheDocument();
    expect(screen.getByText(/104.3 MB download/)).toBeInTheDocument();
    expect(screen.getByText("Pocket TTS")).toBeInTheDocument();
    expect(screen.getByText("Parakeet STT")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download model · Pocket TTS" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Download model · Parakeet STT" }),
    ).toBeEnabled();
    await userEvent.click(screen.getByTestId("voice-model-pocket-download"));
    await userEvent.click(screen.getByTestId("voice-model-parakeet-download"));
    expect(installModel).toHaveBeenNthCalledWith(1, "pocket");
    expect(installModel).toHaveBeenNthCalledWith(2, "parakeet");
  });

  it("keeps one model's progress inline without a combined progress bar", () => {
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup({
          ...baseStatus,
          downloading: true,
          activeModel: "parakeet",
          parakeetProgress: {
            attemptId: 1,
            downloadedBytes: 52_168_914,
            totalBytes: 104_337_827,
            phase: "downloading",
          },
        })}
      />,
    );

    expect(screen.getByText("52.2 MB of 104.3 MB")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", { name: "Parakeet STT" });
    expect(progress).toHaveAttribute("aria-valuenow");
    expect(Number(progress.getAttribute("aria-valuenow"))).toBeCloseTo(50, 5);
    expect(
      screen.getByRole("button", { name: "Download model · Pocket TTS" }),
    ).toBeEnabled();
  });

  it("keeps an installed model removal actionable while the other model downloads", async () => {
    const removeModel = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup(
          {
            ...baseStatus,
            pocketInstalled: true,
            pocketSizeBytes: 173_782_737,
            downloading: true,
            activeModel: "parakeet",
            parakeetProgress: {
              attemptId: 1,
              downloadedBytes: 52_168_914,
              totalBytes: 104_337_827,
              phase: "downloading",
            },
          },
          { removeModel },
        )}
      />,
    );

    const remove = screen.getByRole("button", {
      name: "Remove model · Pocket TTS",
    });
    expect(remove).toBeEnabled();
    await userEvent.click(remove);
    await userEvent.click(screen.getByRole("button", { name: "Remove model" }));
    expect(removeModel).toHaveBeenCalledWith("pocket");
  });

  it("shows a rapid second model click as queued with independent progress", () => {
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup({
          ...baseStatus,
          downloading: true,
          activeModel: "pocket",
          pocketProgress: {
            attemptId: 1,
            downloadedBytes: 60_000_000,
            totalBytes: 173_782_737,
            phase: "downloading",
          },
          parakeetProgress: {
            attemptId: 2,
            downloadedBytes: 0,
            totalBytes: 131_662_414,
            phase: "queued",
          },
        })}
      />,
    );

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText("0.0 MB of 131.7 MB")).toBeInTheDocument();
  });

  it("keeps the setup content mounted when installation completes", () => {
    const view = renderWithProviders(
      <PocketVoiceSetupContent setup={setup(baseStatus)} />,
    );

    view.rerender(
      <PocketVoiceSetupContent
        setup={setup({
          ...baseStatus,
          installed: true,
          pocketInstalled: true,
          parakeetInstalled: true,
          pocketSizeBytes: 173_782_737,
          parakeetSizeBytes: 131_662_414,
        })}
      />,
    );

    expect(screen.getByTestId("voice-model-pocket")).toBeInTheDocument();
    expect(screen.getByTestId("voice-model-parakeet")).toBeInTheDocument();
    expect(screen.getByText(/173.8 MB · Installed/)).toBeInTheDocument();
    expect(screen.getByText(/131.7 MB · Installed/)).toBeInTheDocument();
  });

  it("shows partial-cache disk usage and inline retry without hiding the other model", () => {
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup({
          ...baseStatus,
          pocketInstalled: true,
          pocketSizeBytes: 173_782_737,
          parakeetError: "network failed",
        })}
      />,
    );

    expect(screen.getByText(/173.8 MB · Installed/)).toBeInTheDocument();
    expect(screen.getByText("network failed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Retry model download · Parakeet STT",
      }),
    ).toBeInTheDocument();
  });

  it("renders all installed voices and persists selection", async () => {
    const selectVoice = vi.fn().mockResolvedValue(undefined);
    const previewVoice = vi.fn().mockResolvedValue(undefined);
    const setPlaybackSpeed = vi.fn().mockResolvedValue(undefined);
    const voices = [
      "Anna",
      "Vera",
      "Fantine",
      "Charles",
      "Paul",
      "Eponine",
      "Azelma",
      "George",
      "Mary",
      "Jane",
      "Michael",
      "Eve",
    ].map((name) => ({
      id: name.toLowerCase(),
      name,
    }));
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup(
          {
            ...baseStatus,
            installed: true,
            pocketInstalled: true,
            parakeetInstalled: true,
            pocketSizeBytes: 173_782_737,
            parakeetSizeBytes: 131_662_342,
            voices,
          },
          {
            previewVoice,
            selectVoice,
            setPlaybackSpeed,
          },
        )}
      />,
    );

    await userEvent.click(
      screen.getByRole("combobox", { name: "Playback speed" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "2×" }));
    expect(setPlaybackSpeed).toHaveBeenCalledWith(2);
    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    expect(screen.getAllByRole("radio")).toHaveLength(12);
    await userEvent.click(screen.getByText("Anna"));
    expect(selectVoice).toHaveBeenCalledWith("anna");
    await userEvent.click(screen.getByRole("button", { name: "Preview Anna" }));
    expect(previewVoice).toHaveBeenCalledWith("anna");
  });

  it("keeps voice errors visible inside the open picker", async () => {
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup(
          {
            ...baseStatus,
            installed: true,
            pocketInstalled: true,
            voices: [{ id: "mary", name: "Mary" }],
          },
          { error: "Voice preview failed" },
        )}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Voice preview failed");
    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("alert"),
    ).toHaveTextContent("Voice preview failed");
  });

  it("confirms independent model removal", async () => {
    const removeModel = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <PocketVoiceSetupContent
        setup={setup(
          {
            ...baseStatus,
            installed: true,
            pocketInstalled: true,
            parakeetInstalled: true,
            pocketSizeBytes: 173_782_737,
            parakeetSizeBytes: 131_662_342,
          },
          { removeModel },
        )}
      />,
    );

    await userEvent.click(screen.getByTestId("voice-model-parakeet-remove"));
    expect(
      screen.getByRole("heading", { name: "Remove Parakeet STT?" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove model" }));
    expect(removeModel).toHaveBeenCalledWith("parakeet");
  });
});
