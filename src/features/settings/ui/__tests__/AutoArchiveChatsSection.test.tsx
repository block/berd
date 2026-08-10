import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

  it("defaults to never and persists a selected inactivity duration", async () => {
    const user = userEvent.setup();
    render(<AutoArchiveChatsSection />);

    expect(
      screen.getByRole("combobox", { name: "archive.autoArchive.label" }),
    ).toHaveTextContent("archive.autoArchive.options.never");

    await user.click(
      screen.getByRole("combobox", { name: "archive.autoArchive.label" }),
    );
    await user.click(
      screen.getByRole("option", {
        name: "archive.autoArchive.options.30-days",
      }),
    );

    expect(getAutoArchiveAfter()).toBe("30-days");
    expect(localStorage.getItem(AUTO_ARCHIVE_STORAGE_KEY)).toBe("30-days");
  });
});
