import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExperimentDefinition } from "../experimentDefinitions";
import { ExperimentsSettings } from "../ExperimentsSettings";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "../experimentPreferences";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const uiRegistry = [
  {
    id: "ui-experiment",
    titleKey: "experiments.title",
    descriptionKey: "experiments.description",
    config: {
      enabledConfig: {
        type: "boolean",
        labelKey: "nav.connections",
        defaultValue: false,
      },
      mode: {
        type: "select",
        labelKey: "nav.providers",
        defaultValue: "stable",
        options: [
          { labelKey: "nav.general", value: "stable" },
          { labelKey: "nav.providers", value: "preview" },
        ],
      },
      count: {
        type: "number",
        labelKey: "nav.archive",
        defaultValue: 2,
        min: 1,
        max: 5,
      },
      label: {
        type: "text",
        labelKey: "nav.updates",
        defaultValue: "default",
      },
    },
  },
] as const satisfies readonly ExperimentDefinition[];

describe("ExperimentsSettings", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows an empty state when no experiments are registered", () => {
    vi.stubEnv("DEV", false);
    renderWithProviders(<ExperimentsSettings registry={[]} />);

    expect(
      screen.getByRole("heading", {
        name: i18n.t("experiments.title", { ns: "settings" }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        i18n.t("experiments.emptyDescription", { ns: "settings" }),
      ),
    ).toBeInTheDocument();
  });

  it("renders the registered experiments", () => {
    vi.stubEnv("DEV", false);
    renderWithProviders(<ExperimentsSettings />);

    expect(
      screen.getByRole("switch", {
        name: i18n.t("experiments.builderbot.title", { ns: "settings" }),
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        i18n.t("experiments.builderbot.description", { ns: "settings" }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: i18n.t("experiments.paneJumpNavigation.title", {
          ns: "settings",
        }),
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        i18n.t("experiments.paneJumpNavigation.description", {
          ns: "settings",
        }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        i18n.t("experiments.paneJumpNavigation.shortcutMoved", {
          ns: "settings",
        }),
      ),
    ).toBeInTheDocument();
  });

  it("points the pane jump shortcut control at keyboard shortcut settings", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();
    const openSettingsListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
    renderWithProviders(<ExperimentsSettings />);

    // Editing moved to Settings → Keyboard shortcuts; no recording input.
    expect(
      screen.queryByRole("textbox", {
        name: i18n.t("experiments.paneJumpNavigation.shortcutLabel", {
          ns: "settings",
        }),
      }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("nav.shortcuts", { ns: "settings" }),
      }),
    );

    expect(openSettingsListener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { section: "shortcuts" } }),
    );
    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
  });

  it("renders dev default copy on a separate line", () => {
    vi.stubEnv("DEV", true);
    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    expect(
      screen.getByText(
        i18n.t("experiments.autoEnable.description", { ns: "settings" }),
      ),
    ).toBeInTheDocument();
  });

  it("hides dev default copy outside dev builds", () => {
    vi.stubEnv("DEV", false);
    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    expect(
      screen.queryByText(
        i18n.t("experiments.autoEnable.description", { ns: "settings" }),
      ),
    ).not.toBeInTheDocument();
  });

  it("applies the dev default to untouched experiments", () => {
    vi.stubEnv("DEV", true);
    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    expect(screen.getByRole("switch", { name: "Experiments" })).toBeChecked();
  });

  it("renders injected experiment controls and persists changes after enabling", async () => {
    vi.stubEnv("DEV", false);
    const user = userEvent.setup();

    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    const switchControl = screen.getByRole("switch", { name: "Experiments" });
    expect(switchControl).not.toBeChecked();
    expect(screen.getByLabelText("Archive")).toBeDisabled();

    await user.click(switchControl);
    expect(switchControl).toBeChecked();

    await user.click(screen.getByRole("switch", { name: "Connections" }));

    await user.click(screen.getByRole("combobox", { name: "AI providers" }));
    await user.click(
      await screen.findByRole("option", { name: "AI providers" }),
    );

    const numberInput = screen.getByLabelText("Archive");
    await user.clear(numberInput);
    expect(numberInput).toHaveValue(null);
    await user.type(numberInput, "15");
    expect(numberInput).toHaveValue(15);
    await user.keyboard("{Enter}");
    expect(numberInput).toHaveValue(5);

    await user.clear(screen.getByLabelText("Updates"));
    await user.type(screen.getByLabelText("Updates"), "custom");
    expect(
      JSON.parse(localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "")
        .experiments["ui-experiment"].config.label,
    ).toBeUndefined();

    await user.tab();

    expect(
      JSON.parse(localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "")
        .experiments["ui-experiment"],
    ).toEqual({
      enabled: true,
      config: {
        count: 5,
        enabledConfig: true,
        label: "custom",
        mode: "preview",
      },
    });
  });

  it("shows reset-to-auto after a manual experiment override", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();

    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    const experimentSwitch = screen.getByRole("switch", {
      name: "Experiments",
    });

    expect(experimentSwitch).toBeChecked();

    await user.click(experimentSwitch);
    expect(experimentSwitch).not.toBeChecked();
    expect(
      screen.getByRole("button", {
        name: i18n.t("experiments.resetToAuto", { ns: "settings" }),
      }),
    ).toBeInTheDocument();
  });

  it("resets explicit experiment overrides back to the dev auto default", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();

    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    const experimentSwitch = screen.getByRole("switch", {
      name: "Experiments",
    });

    expect(experimentSwitch).toBeChecked();

    await user.click(experimentSwitch);
    expect(experimentSwitch).not.toBeChecked();

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.resetToAuto", { ns: "settings" }),
      }),
    );

    expect(experimentSwitch).toBeChecked();
    expect(
      screen.queryByRole("button", {
        name: i18n.t("experiments.resetToAuto", { ns: "settings" }),
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps config controls nested and disabled when effective experiment state is off", () => {
    vi.stubEnv("DEV", false);

    renderWithProviders(<ExperimentsSettings registry={uiRegistry} />);

    expect(screen.getByLabelText("Archive")).toBeDisabled();
    expect(screen.getByLabelText("Updates")).toBeDisabled();
  });
});
