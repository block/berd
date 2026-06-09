import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

async function renderOpenDialog(onOpenChange: (open: boolean) => void) {
  renderWithProviders(
    <KeyboardShortcutsDialog open onOpenChange={onOpenChange} />,
  );
  await waitFor(() => {
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
  });
}

describe("KeyboardShortcutsDialog", () => {
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
});
