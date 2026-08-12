import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppContentPlaceholder } from "./AppContentPlaceholder";
import { I18nProvider } from "@/shared/i18n";

function renderSettingsPlaceholder() {
  return render(
    <I18nProvider>
      <AppContentPlaceholder
        location={{ view: "settings", settingsSection: "appearance" }}
      />
    </I18nProvider>,
  );
}

describe("AppContentPlaceholder", () => {
  it("matches the current settings surface, section, and row layout", () => {
    const { container } = renderSettingsPlaceholder();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(container.querySelector(".bg-card.rounded-md")).toBeInTheDocument();
    expect(container.querySelector(".max-w-3xl.px-6.pt-8")).toBeInTheDocument();
    expect(container.querySelector(".space-y-11")).toBeInTheDocument();
    expect(
      container.querySelector(".divide-y.divide-border"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[class*="border-border/60"]'),
    ).not.toBeInTheDocument();
  });

  it("keeps the home placeholder on the canvas surface, not paper", () => {
    // The home placeholder covers the content canvas while navigation
    // settles; painting bg-background (the paper alias of card) would
    // flash a raised-card rectangle over the darker canvas in dark mode.
    const { container } = render(
      <I18nProvider>
        <AppContentPlaceholder location={{ view: "home" }} />
      </I18nProvider>,
    );

    expect(container.querySelector(".bg-canvas-base")).toBeInTheDocument();
    expect(container.querySelector('[class*="bg-background"]')).toBeNull();
  });
});
