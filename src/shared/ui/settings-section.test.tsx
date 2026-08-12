import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SettingsSection, SettingsSections } from "./settings-section";

it("applies the shared settings section hierarchy and spacing", () => {
  render(
    <SettingsSections>
      <SettingsSection title="Installed" titleId="installed-title">
        <div>Connection</div>
      </SettingsSection>
      <SettingsSection title="Available">
        <div>Another connection</div>
      </SettingsSection>
    </SettingsSections>,
  );

  expect(
    screen.getByText("Connection").closest('[data-slot="settings-sections"]'),
  ).toHaveClass("space-y-11");
  expect(
    screen.getByRole("heading", { name: "Installed", level: 2 }),
  ).toHaveClass("font-display", "text-base", "font-medium", "tracking-tight");
  expect(
    screen.getByRole("heading", { name: "Installed" }).closest("section"),
  ).toHaveAttribute("aria-labelledby", "installed-title");
});
