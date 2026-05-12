import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { renderWithProviders } from "@/test/render";
import { GeneralSettings } from "../GeneralSettings";

describe("GeneralSettings appearance section", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-density");
    document.documentElement.style.removeProperty("--density-spacing");
    document.documentElement.style.removeProperty("--spacing");
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
