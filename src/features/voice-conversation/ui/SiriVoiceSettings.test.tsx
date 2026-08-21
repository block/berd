import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { SiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import { SiriVoiceSettings } from "./SiriVoiceSettings";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

function setup(overrides: Partial<SiriVoiceSetup> = {}): SiriVoiceSetup {
  return {
    status: {
      supported: true,
      availableLanguages: ["en-US", "en-AU", "en-IN"],
      selectedVoice: null,
      selectedVoiceInstalled: false,
      playbackSpeed: 1,
      voices: [
        {
          name: "Quinn",
          language: "en-US",
          sizeBytes: 310_500_000,
          installed: false,
        },
      ],
    },
    language: "en-US",
    languages: ["en-AU", "en-IN", "en-US"],
    loading: false,
    error: null,
    downloadingVoiceKey: null,
    previewingVoiceKey: null,
    setLanguage: vi.fn(),
    setPlaybackSpeed: vi.fn().mockResolvedValue(undefined),
    downloadVoice: vi.fn().mockResolvedValue(undefined),
    previewVoice: vi.fn().mockResolvedValue(undefined),
    selectVoice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("SiriVoiceSettings", () => {
  it("offers exact regional locale filters", async () => {
    const value = setup();
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    await userEvent.click(screen.getByRole("combobox", { name: "Language" }));
    expect(
      screen.getByRole("option", { name: "American English" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Australian English" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Indian English" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "English" })).toBeNull();
  });

  it("previews a Siri voice before download", async () => {
    const value = setup();
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Preview Quinn" }),
    );
    expect(value.previewVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Quinn", installed: false }),
    );
    expect(
      screen.getByRole("button", { name: "Download Quinn" }),
    ).toBeInTheDocument();
  });

  it("gives each voice action a voice-specific accessible name", () => {
    const value = setup({
      status: {
        ...setup().status!,
        voices: [
          {
            name: "Aaron",
            language: "en-US",
            sizeBytes: 0,
            installed: true,
          },
          {
            name: "Quinn",
            language: "en-US",
            sizeBytes: 310_500_000,
            installed: false,
          },
        ],
      },
    });
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    expect(
      screen.getByRole("button", { name: "Preview Aaron" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use Aaron" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download Quinn" }),
    ).toBeInTheDocument();
  });

  it("exposes preview and download progress in accessible names", () => {
    const value = setup({
      previewingVoiceKey: "quinn|en-us",
      downloadingVoiceKey: "quinn|en-us",
    });
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    expect(
      screen.getByRole("button", { name: "Playing preview for Quinn" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Downloading Quinn" }),
    ).toBeInTheDocument();
  });
});
