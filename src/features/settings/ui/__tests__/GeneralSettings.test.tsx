import { fireEvent, screen, waitFor } from "@testing-library/react";
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

    await user.type(screen.getByTestId("theme-search-input"), "dracula");
    expect(screen.getByTestId("theme-option-dracula")).toBeVisible();
    expect(
      screen.queryByTestId("theme-option-github-light"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("theme-option-dracula"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-custom-theme")).toBe("dracula");
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
  });

  it("selects default light and dark theme modes", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    await user.click(screen.getByTestId("theme-option-dark"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-theme-mode")).toBe("dark");
    });

    await user.click(screen.getByTestId("theme-option-light"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-theme-mode")).toBe("light");
    });
  });

  it("sets and resets a custom primary color", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByTestId("primary-color-input"), {
      target: { value: "#22c55e" },
    });

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBe("#22c55e");
    });

    await user.click(screen.getByTestId("primary-color-reset"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBeNull();
    });
  });

  it("updates interface density from the appearance controls", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>,
    );

    const compact = screen.getByRole("button", { name: "Compact" });

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
    expect(compact).toHaveAttribute("aria-pressed", "true");
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
