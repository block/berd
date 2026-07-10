import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
  NAVIGATION_REFRESH_EXPERIMENT_ID,
  type ExperimentDefinition,
} from "../experimentDefinitions";
import { ExperimentsSettings } from "../ExperimentsSettings";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "../experimentPreferences";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: getPlatformMock,
}));

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
        labelKey: "nav.notifications",
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

function experimentDescriptionText(experimentKey: "globalShortcut") {
  return i18n.t(`experiments.${experimentKey}.description`, {
    ns: "settings",
  });
}

describe("ExperimentsSettings", () => {
  beforeEach(() => {
    getPlatformMock.mockReturnValue("mac");
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
        name: i18n.t("experiments.globalShortcut.title", { ns: "settings" }),
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === experimentDescriptionText("globalShortcut"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: i18n.t("experiments.sidebarDetachableChats.title", {
          ns: "settings",
        }),
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        i18n.t("experiments.sidebarDetachableChats.description", {
          ns: "settings",
        }),
      ),
    ).toBeInTheDocument();
    const navigationExperimentsCard = screen.getByRole("region", {
      name: i18n.t("experiments.navigationExperiments.title", {
        ns: "settings",
      }),
    });
    expect(navigationExperimentsCard).toBeInTheDocument();
    expect(
      within(navigationExperimentsCard).getByRole("switch", {
        name: i18n.t("experiments.navigationRefresh.title", {
          ns: "settings",
        }),
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        i18n.t("experiments.navigationRefresh.description", {
          ns: "settings",
        }),
      ),
    ).toBeInTheDocument();
    const chatsUnderProjectsSwitch = within(
      navigationExperimentsCard,
    ).getByRole("switch", {
      name: i18n.t("experiments.navigationChatsUnderProjects.title", {
        ns: "settings",
      }),
    });
    expect(chatsUnderProjectsSwitch).not.toBeChecked();
    expect(chatsUnderProjectsSwitch).toBeDisabled();
    expect(
      screen.getByText(
        i18n.t("experiments.navigationChatsUnderProjects.description", {
          ns: "settings",
        }),
      ),
    ).toBeInTheDocument();
    expect(
      within(navigationExperimentsCard).queryByText(
        i18n.t("experiments.defaultLabel", { ns: "settings" }),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent)
        .at(-1),
    ).toBe(i18n.t("experiments.globalShortcut.title", { ns: "settings" }));
  });

  it("keeps the default navigation separate from opt-in nav experiments", async () => {
    vi.stubEnv("DEV", false);
    const user = userEvent.setup();

    renderWithProviders(<ExperimentsSettings />);

    const navigationExperimentsCard = screen.getByRole("region", {
      name: i18n.t("experiments.navigationExperiments.title", {
        ns: "settings",
      }),
    });
    const navigationRefreshSwitch = screen.getByRole("switch", {
      name: i18n.t("experiments.navigationRefresh.title", {
        ns: "settings",
      }),
    });
    const chatsUnderProjectsSwitch = screen.getByRole("switch", {
      name: i18n.t("experiments.navigationChatsUnderProjects.title", {
        ns: "settings",
      }),
    });

    expect(navigationRefreshSwitch).not.toBeChecked();
    expect(chatsUnderProjectsSwitch).not.toBeChecked();
    expect(chatsUnderProjectsSwitch).toBeDisabled();
    expect(
      within(navigationExperimentsCard).queryByRole("button", {
        name: i18n.t("experiments.resetToAuto", { ns: "settings" }),
      }),
    ).not.toBeInTheDocument();

    await user.click(navigationRefreshSwitch);

    expect(navigationRefreshSwitch).toBeChecked();
    expect(chatsUnderProjectsSwitch).not.toBeChecked();
    expect(chatsUnderProjectsSwitch).not.toBeDisabled();

    await user.click(chatsUnderProjectsSwitch);
    expect(chatsUnderProjectsSwitch).toBeChecked();

    expect(
      JSON.parse(localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "")
        .experiments[NAVIGATION_REFRESH_EXPERIMENT_ID].enabled,
    ).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "")
        .experiments[NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID].enabled,
    ).toBe(true);
  });

  it("hides the global shortcut experiment off macOS", () => {
    vi.stubEnv("DEV", false);
    getPlatformMock.mockReturnValue("windows");

    renderWithProviders(<ExperimentsSettings />);

    expect(
      screen.queryByRole("switch", {
        name: i18n.t("experiments.globalShortcut.title", { ns: "settings" }),
      }),
    ).not.toBeInTheDocument();
  });

  it("opens keyboard shortcut settings from the Global shortcut control", async () => {
    vi.stubEnv("DEV", false);
    const user = userEvent.setup();
    const openSettingsListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
    renderWithProviders(<ExperimentsSettings />);

    const globalShortcutSection = screen
      .getByRole("switch", {
        name: i18n.t("experiments.globalShortcut.title", { ns: "settings" }),
      })
      .closest("section");
    expect(globalShortcutSection).not.toBeNull();

    await user.click(
      within(globalShortcutSection as HTMLElement).getByRole("button", {
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

    await user.click(screen.getByRole("switch", { name: "Notifications" }));

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
