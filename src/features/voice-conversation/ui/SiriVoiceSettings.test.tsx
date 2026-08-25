import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { i18n } from "@/shared/i18n";
import type { SiriVoiceSetup } from "../hooks/useSiriVoiceSetup";
import { SiriVoiceSettings } from "./SiriVoiceSettings";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

function setup(overrides: Partial<SiriVoiceSetup> = {}): SiriVoiceSetup {
  return {
    status: {
      supported: true,
      availableLanguages: ["en-US", "en-AU", "en-IN", "en-IE"],
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
    languages: ["en-AU", "en-IN", "en-IE", "en-US"],
    loading: false,
    error: null,
    statusError: null,
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

    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Language" }));
    expect(
      screen.getByRole("option", { name: "English (United States)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "English (Australia)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "English (India)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "English (Ireland)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "American English" }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: "English" })).toBeNull();

    await userEvent.click(
      screen.getByRole("option", { name: "English (Australia)" }),
    );
    expect(value.setLanguage).toHaveBeenCalledWith("en-AU");
  });

  it("does not repeat the selected locale above a single voice group", async () => {
    const value = setup();
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    expect(
      screen.queryByRole("heading", { name: "English (United States)" }),
    ).toBeNull();
  });

  it("sorts language options and groups with the active Berd locale", async () => {
    const nativeCollator = Intl.Collator;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    try {
      const voices = [
        {
          name: "Voz española",
          language: "es-ES",
          sizeBytes: 1,
          installed: true,
        },
        {
          name: "Voz francesa",
          language: "fr-FR",
          sizeBytes: 1,
          installed: true,
        },
        {
          name: "Voz inglesa",
          language: "en-US",
          sizeBytes: 1,
          installed: true,
        },
        {
          name: "Nza",
          language: "en-US",
          sizeBytes: 1,
          installed: true,
        },
        {
          name: "Ña",
          language: "en-US",
          sizeBytes: 1,
          installed: true,
        },
      ];
      const status = setup().status;
      expect(status).not.toBeNull();
      if (!status) return;
      const value = setup({
        languages: ["fr-FR", "en-US", "es-ES"],
        status: {
          ...status,
          availableLanguages: ["fr-FR", "en-US", "es-ES"],
          voices,
        },
      });

      renderWithProviders(<SiriVoiceSettings setup={value} />);

      await userEvent.click(
        screen.getByRole("button", { name: /^Elige una voz:/ }),
      );
      const displayNames = new Intl.DisplayNames(["es"], {
        type: "language",
        languageDisplay: "standard",
      });
      const collator = new nativeCollator("es");
      const expected = ["fr-FR", "en-US", "es-ES"]
        .map((locale) => displayNames.of(locale) ?? locale)
        .sort(collator.compare);
      expect(
        screen
          .getAllByRole("heading", { level: 3 })
          .map((heading) => heading.textContent),
      ).toEqual(expected);
      expect(
        screen
          .getByText("Nza")
          .compareDocumentPosition(screen.getByText("Ña")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("combobox", { name: "Idioma" }));
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(expected);
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("previews a Siri voice before download", async () => {
    const value = setup();
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
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

  it("selects installed voices from a compact, accessible row", async () => {
    const status = setup().status;
    expect(status).not.toBeNull();
    if (!status) return;
    const value = setup({
      status: {
        ...status,
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

    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    expect(
      screen.getByRole("button", { name: "Preview Aaron" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use Aaron" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download Quinn" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0.0 MB · Installed")).toBeInTheDocument();
    expect(screen.getByText("310.5 MB")).toBeInTheDocument();
    expect(screen.queryByText("Use voice")).not.toBeInTheDocument();
    expect(screen.queryByText("Download model")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use Aaron" }));
    expect(value.selectVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Aaron", installed: true }),
    );
  });

  it("exposes preview and download progress in accessible names", async () => {
    const value = setup({
      previewingVoiceKey: "quinn|en-us",
      downloadingVoiceKey: "quinn|en-us",
    });
    renderWithProviders(<SiriVoiceSettings setup={value} />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Choose a voice:/ }),
    );
    expect(
      screen.getByRole("button", { name: "Playing preview for Quinn" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Downloading Quinn" }),
    ).toBeInTheDocument();
  });
});
