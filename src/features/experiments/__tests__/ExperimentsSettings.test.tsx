import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BERDY_ONBOARDING_EXPERIMENT_ID,
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  CHAT_ON_CANVAS_EXPERIMENT_ID,
  EXPERIMENT_DEFINITIONS,
  PROMPT_PINS_EXPERIMENT_ID,
  RELATED_PULL_REQUESTS_EXPERIMENT_ID,
  REMOTE_SSH_SESSIONS_EXPERIMENT_ID,
  SKILL_DISCOVERY_EXPERIMENT_ID,
  STARTER_TASKS_EXPERIMENT_ID,
  TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
  type ExperimentDefinition,
} from "../experimentDefinitions";
import { ExperimentsSettings } from "../ExperimentsSettings";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "../experimentPreferences";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";

const resetOnboardingTourExperienceMock = vi.hoisted(() =>
  vi.fn(async () => true),
);
const resetHomeForOnboardingExperienceMock = vi.hoisted(() =>
  vi.fn(async () => true),
);
const resetStarterTasksExperienceMock = vi.hoisted(() =>
  vi.fn(async () => true),
);
const syncOnboardingExperimentStateMock = vi.hoisted(() =>
  vi.fn(async () => {}),
);
vi.mock("@/features/onboarding/resetOnboardingTour", () => ({
  resetHomeForOnboardingExperience: resetHomeForOnboardingExperienceMock,
  resetOnboardingTourExperience: resetOnboardingTourExperienceMock,
  resetStarterTasksExperience: resetStarterTasksExperienceMock,
  syncOnboardingExperimentState: syncOnboardingExperimentStateMock,
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

describe("ExperimentsSettings", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    resetOnboardingTourExperienceMock.mockClear();
    resetHomeForOnboardingExperienceMock.mockClear();
    resetStarterTasksExperienceMock.mockClear();
    syncOnboardingExperimentStateMock.mockClear();
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

  it("renders the registered experiments when their build family is enabled", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_BUILDERBOT", "1");
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
  });

  it("registers only the currently supported experiments", () => {
    expect(EXPERIMENT_DEFINITIONS.map(({ id }) => id)).toEqual([
      BUILDERBOT_SURFACE_EXPERIMENT_ID,
      TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
      SKILL_DISCOVERY_EXPERIMENT_ID,
      STARTER_TASKS_EXPERIMENT_ID,
      VOICE_CONVERSATION_EXPERIMENT_ID,
      CHAT_ON_CANVAS_EXPERIMENT_ID,
      BERDY_ONBOARDING_EXPERIMENT_ID,
      RELATED_PULL_REQUESTS_EXPERIMENT_ID,
      PROMPT_PINS_EXPERIMENT_ID,
      REMOTE_SSH_SESSIONS_EXPERIMENT_ID,
    ]);
  });

  it("keeps chat on canvas manual-only and off by default", () => {
    expect(
      EXPERIMENT_DEFINITIONS.find(
        ({ id }) => id === CHAT_ON_CANVAS_EXPERIMENT_ID,
      ),
    ).toMatchObject({
      defaultEnabled: false,
      manualEnableOnly: true,
    });
  });

  it("groups onboarding experiments and resets all onboarding experiences", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();
    renderWithProviders(<ExperimentsSettings />);

    const onboardingGroup = screen.getByRole("region", {
      name: i18n.t("experiments.onboarding.title", { ns: "settings" }),
    });
    expect(onboardingGroup).toHaveTextContent(
      i18n.t("experiments.starterTasks.title", { ns: "settings" }),
    );
    expect(onboardingGroup).toHaveTextContent(
      i18n.t("experiments.berdyOnboarding.title", { ns: "settings" }),
    );

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.onboarding.resetAll", { ns: "settings" }),
      }),
    );

    expect(
      screen.getByRole("dialog", {
        name: i18n.t("experiments.onboarding.confirmTitle", { ns: "settings" }),
      }),
    ).toBeInTheDocument();
    expect(resetHomeForOnboardingExperienceMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.onboarding.confirm", { ns: "settings" }),
      }),
    );

    expect(resetHomeForOnboardingExperienceMock).toHaveBeenCalledOnce();
  });

  it("hides onboarding experiment controls outside dev builds", () => {
    vi.stubEnv("DEV", false);
    renderWithProviders(<ExperimentsSettings />);

    expect(
      screen.queryByText(
        i18n.t("experiments.starterTasks.title", { ns: "settings" }),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        i18n.t("experiments.berdyOnboarding.title", { ns: "settings" }),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", {
        name: i18n.t("experiments.onboarding.title", { ns: "settings" }),
      }),
    ).not.toBeInTheDocument();
  });

  it("preserves first-run state when reset-all preparation fails", async () => {
    vi.stubEnv("DEV", true);
    resetHomeForOnboardingExperienceMock.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    renderWithProviders(<ExperimentsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.onboarding.resetAll", { ns: "settings" }),
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.onboarding.confirm", { ns: "settings" }),
      }),
    );
  });

  it("resets Berdy onboarding from its experiment card", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();
    renderWithProviders(<ExperimentsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: i18n.t("experiments.berdyOnboarding.resetLabel", {
          ns: "settings",
        }),
      }),
    );

    expect(resetOnboardingTourExperienceMock).toHaveBeenCalledOnce();
  });

  it("syncs Berdy onboarding when its dev-only experiment is toggled", async () => {
    vi.stubEnv("DEV", true);
    const user = userEvent.setup();
    renderWithProviders(<ExperimentsSettings />);

    await user.click(
      screen.getByRole("switch", {
        name: i18n.t("experiments.berdyOnboarding.title", {
          ns: "settings",
        }),
      }),
    );

    expect(syncOnboardingExperimentStateMock).toHaveBeenCalledWith(false);
  });

  it("does not advertise the retired macOS 26 voice requirement", () => {
    const description = i18n.t("experiments.voiceConversation.description", {
      ns: "settings",
    });

    expect(description).toBe(
      "Try continuous two-way voice conversations in Goose chats.",
    );
    expect(description).not.toMatch(/macOS 26/i);
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
