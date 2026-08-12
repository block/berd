import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setShortcutOverride,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
} from "@/features/shortcuts/lib/shortcutRegistry";
import { renderWithProviders } from "@/test/render";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

async function renderOpenDialog(onOpenChange: (open: boolean) => void) {
  renderWithProviders(
    <KeyboardShortcutsDialog open onOpenChange={onOpenChange} />,
  );
  await waitFor(() => {
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
  });
}

function getShortcutRow(label: string) {
  const row = screen.getByText(label).closest("li");
  if (!row) {
    throw new Error(`Shortcut row for "${label}" not found`);
  }
  return row;
}

describe("KeyboardShortcutsDialog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders grouped shortcuts when open", async () => {
    await renderOpenDialog(() => {});

    expect(screen.getByText("Open search")).toBeInTheDocument();
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onOpenChange = vi.fn();
    await renderOpenDialog(onOpenChange);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("does not close on ordinary key presses", async () => {
    const onOpenChange = vi.fn();
    await renderOpenDialog(onOpenChange);

    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("has a close button", async () => {
    const onOpenChange = vi.fn();
    await renderOpenDialog(onOpenChange);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("renders the overridden combo when an override is stored", async () => {
    localStorage.setItem(
      SHORTCUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "navigation.search": "meta+shift+x" },
      }),
    );
    await renderOpenDialog(() => {});

    expect(getShortcutRow("Open search")).toHaveTextContent("⌘⇧X");
  });

  it("updates while open when an override changes and still closes on Escape", async () => {
    const onOpenChange = vi.fn();
    await renderOpenDialog(onOpenChange);

    expect(getShortcutRow("Open search")).toHaveTextContent("⌘K");

    act(() => {
      const result = setShortcutOverride("navigation.search", "meta+shift+x");
      expect(result).toEqual({ ok: true });
    });

    expect(getShortcutRow("Open search")).toHaveTextContent("⌘⇧X");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
