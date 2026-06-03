import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { ExperimentDefinition } from "../experimentDefinitions";
import { ExperimentsSettings } from "../ExperimentsSettings";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "../experimentPreferences";
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

  it("shows an empty state when no experiments are registered", () => {
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

  it("renders the registered Builderbot experiment", () => {
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

  it("renders injected experiment controls and persists changes after enabling", async () => {
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
});
