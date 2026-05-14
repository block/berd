import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { renderWithProviders } from "@/test/render";
import { GeneralSettings } from "../GeneralSettings";

describe("GeneralSettings appearance section", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-density");
    document.documentElement.style.removeProperty("--density-spacing");
    document.documentElement.style.removeProperty("--spacing");
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("filters and selects adaptive syntax themes", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme-option-system")).toBeVisible();
    expect(screen.getByTestId("accent-color-red")).toBeDisabled();

    await user.type(screen.getByTestId("theme-search-input"), "dracula");
    expect(screen.getByTestId("theme-option-dracula")).toBeVisible();
    expect(
      screen.queryByTestId("theme-option-github-light"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("theme-option-dracula"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-custom-theme")).toBe("dracula");
    });
    expect(screen.getByTestId("accent-color-red")).toBeEnabled();

    await user.click(screen.getByTestId("accent-color-red"));
    await waitFor(() => {
      expect(localStorage.getItem("goose-accent-color")).toBe("#ef4444");
    });
  });

  it("returns adaptive theming to system mode", async () => {
    const user = userEvent.setup();
    localStorage.setItem("goose-custom-theme", "dracula");

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(localStorage.getItem("goose-custom-theme")).toBe("dracula");
    });

    await user.click(screen.getByTestId("theme-option-system"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-custom-theme")).toBeNull();
    });
    expect(screen.getByTestId("accent-color-red")).toBeDisabled();
  });

  it("updates interface density from the appearance controls", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    const compact = screen.getByRole("radio", { name: "Compact" });

    await user.click(compact);

    await waitFor(() => {
      expect(localStorage.getItem("goose-density")).toBe("compact");
      expect(document.documentElement.dataset.density).toBe("compact");
      expect(
        document.documentElement.style.getPropertyValue("--density-spacing"),
      ).toBe("");
      expect(document.documentElement.style.getPropertyValue("--spacing")).toBe(
        "",
      );
    });
    expect(compact).toHaveAttribute("data-state", "on");
  });

  it("restores Agent Tools composer tips", async () => {
    const user = userEvent.setup();
    localStorage.setItem("goose:agent-tools-tips-enabled", "false");

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    const switchControl = screen.getByRole("switch", {
      name: "Chat tips",
    });

    expect(switchControl).not.toBeChecked();

    await user.click(switchControl);

    await waitFor(() => {
      expect(localStorage.getItem("goose:agent-tools-tips-enabled")).toBe(
        "true",
      );
    });
    expect(switchControl).toBeChecked();
  });
});
