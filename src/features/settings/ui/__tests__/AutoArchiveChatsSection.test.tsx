import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_ARCHIVE_CONSENT_STORAGE_KEY,
  AUTO_ARCHIVE_STORAGE_KEY,
  getAutoArchiveAfter,
} from "@/features/settings/lib/autoArchivePreference";
import { AutoArchiveChatsSection } from "../AutoArchiveChatsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("AutoArchiveChatsSection", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to never and does not enable a duration without confirmation", async () => {
    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, "14-days");
    const user = userEvent.setup();
    render(<AutoArchiveChatsSection />);

    const picker = screen.getByRole("combobox", {
      name: "archive.autoArchive.label",
    });
    expect(picker).toHaveTextContent("archive.autoArchive.options.never");

    await user.click(picker);
    await user.click(
      screen.getByRole("option", {
        name: "archive.autoArchive.options.30-days",
      }),
    );

    expect(getAutoArchiveAfter()).toBe("never");
    expect(
      screen.getByRole("dialog", {
        name: "archive.autoArchive.confirmTitle",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "common:actions.cancel" }),
    );
    expect(getAutoArchiveAfter()).toBe("never");
  });

  it("persists the duration only after explicit confirmation", async () => {
    const user = userEvent.setup();
    render(<AutoArchiveChatsSection />);

    await user.click(
      screen.getByRole("combobox", { name: "archive.autoArchive.label" }),
    );
    await user.click(
      screen.getByRole("option", {
        name: "archive.autoArchive.options.30-days",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "archive.autoArchive.confirmAction",
      }),
    );

    expect(getAutoArchiveAfter()).toBe("30-days");
    expect(localStorage.getItem(AUTO_ARCHIVE_STORAGE_KEY)).toBe("30-days");
    expect(localStorage.getItem(AUTO_ARCHIVE_CONSENT_STORAGE_KEY)).toBe("true");
  });
});
