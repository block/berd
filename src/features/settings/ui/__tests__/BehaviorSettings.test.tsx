import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { BehaviorSettings } from "../BehaviorSettings";

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => false,
  getProfileCapabilitySnapshot: () => false,
}));
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableConfigRead: async () => ({ value: 272_000 }),
      GooseUnstablePreferencesRead: async () => ({
        values: [{ key: "autoCompactThreshold", value: 0.9 }],
      }),
    },
  }),
}));

describe("Behavior settings context group", () => {
  it.each([
    "en",
    "es",
  ])("frames both Goose controls together in %s", async (locale) => {
    await i18n.changeLanguage(locale);
    render(<BehaviorSettings />);
    const t = (key: string) => i18n.t(key, { ns: "settings" });
    const heading = screen.getByRole("heading", {
      name: t("compaction.title"),
    });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    if (!section) throw new Error("Missing context settings section");
    const rowLabel = within(section).getByText(t("compaction.goose.label"));
    const row = rowLabel.closest('[data-slot="settings-row"]');
    expect(row).not.toBeNull();
    if (!row) throw new Error("Missing combined context settings row");
    const controls = within(row as HTMLElement);
    expect(
      controls.getByText(t("compaction.goose.description")),
    ).toBeInTheDocument();
    const maxContext = controls.getByRole("spinbutton", {
      name: t("compaction.goose.contextLimit.exactLabel"),
    });
    await waitFor(() => expect(maxContext).toBeEnabled());
    expect(
      controls.getByRole("slider", {
        name: t("compaction.goose.autoCompact.label"),
      }),
    ).toBeInTheDocument();
    // Assert the framing, not just translation-key wiring: both languages
    // explicitly name context instead of the previous compaction-only copy.
    expect(heading).toHaveTextContent(/context/i);
    expect(rowLabel).toHaveTextContent(/context/i);
  });
});
