import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SHORTCUT_PREFERENCES_STORAGE_KEY } from "@/features/shortcuts/lib/shortcutRegistry";
import { renderWithProviders } from "@/test/render";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

function storedOverrides(): Record<string, string> | null {
  const raw = localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
  if (raw === null) return null;
  return (JSON.parse(raw) as { overrides: Record<string, string> }).overrides;
}

function seedOverrides(overrides: Record<string, string>) {
  localStorage.setItem(
    SHORTCUT_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ version: 1, overrides }),
  );
}

function getShortcutButton(commandLabel: string) {
  // The accessible name carries the current combo, e.g.
  // "Change shortcut for Open search (⌘K)".
  return screen.getByRole("button", {
    name: new RegExp(`^Change shortcut for ${commandLabel}`),
  });
}

describe("KeyboardShortcutsSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders configurable rows grouped by category and omits fixed commands", () => {
    renderWithProviders(<KeyboardShortcutsSettings />);

    const navigationSection = screen
      .getByRole("heading", { name: "Navigation" })
      .closest("section");
    expect(navigationSection).not.toBeNull();
    expect(
      within(navigationSection as HTMLElement).getByText("Open search"),
    ).toBeInTheDocument();

    const chatSection = screen
      .getByRole("heading", { name: "Chat" })
      .closest("section");
    expect(chatSection).not.toBeNull();
    expect(
      within(chatSection as HTMLElement).getByText("Send message"),
    ).toBeInTheDocument();

    // Fixed (configurable: false) commands are not editable rows.
    expect(
      screen.queryByText("Insert selected mention"),
    ).not.toBeInTheDocument();

    // No overrides yet: reset all is disabled.
    expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();
  });

  it("renders the global shortcut toggle on mac, reflecting and updating the preference", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    const toggle = screen.getByRole("switch", {
      name: "Enable global shortcut",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem("goose:global-shortcut-enabled")).toBe("true");
  });

  it("shows shortcut buttons with content-hugging padding and flat keycaps", () => {
    renderWithProviders(<KeyboardShortcutsSettings />);

    expect(screen.getByText("Global shortcut")).toBeInTheDocument();
    const button = getShortcutButton("Global shortcut");
    expect(button).toHaveTextContent("⌥Space");
    expect(button).toHaveClass("w-fit", "px-1.5");
    expect(button).not.toHaveClass("min-w-24");
    for (const keycap of button.querySelectorAll('[data-slot="kbd"]')) {
      expect(keycap).toHaveClass("shadow-none");
    }
  });

  it("records a new shortcut for a command", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    const button = getShortcutButton("Open search");
    expect(button).toHaveTextContent("⌘K");

    await user.click(button);
    expect(button).toHaveTextContent("Press shortcut…");

    fireEvent.keyDown(button, { key: "x", metaKey: true, shiftKey: true });

    expect(storedOverrides()).toEqual({ "navigation.search": "meta+shift+x" });
    expect(button).toHaveTextContent("⌘⇧X");
    expect(screen.getByText("Default: ⌘K")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset to default" }),
    ).toBeInTheDocument();
  });

  it("surfaces inline errors per failure mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    // Unmodified key on a global command: invalid, stays recording.
    const searchButton = getShortcutButton("Open search");
    await user.click(searchButton);
    fireEvent.keyDown(searchButton, { key: "k" });
    expect(
      screen.getByText("Shortcuts need a modifier key like Cmd, Ctrl, or Alt"),
    ).toBeInTheDocument();
    // Still recording so the user can try again.
    expect(searchButton).toHaveTextContent("Press shortcut…");
    expect(storedOverrides(), "after invalid global key").toBeNull();

    // Conflict with another command: error names it, recording exits.
    fireEvent.keyDown(searchButton, { key: "n", metaKey: true });
    expect(
      screen.getByText('Already used by "New conversation"'),
    ).toBeInTheDocument();
    // Recording exited; the current binding is shown again.
    expect(searchButton).toHaveTextContent("⌘K");
    expect(storedOverrides(), "after conflict").toBeNull();

    // Unmodified text-editing key on a composer command: tailored message.
    const sendButton = getShortcutButton("Send message");
    await user.click(sendButton);
    fireEvent.keyDown(sendButton, { key: "Backspace" });
    expect(
      screen.getByText(
        "That key can't be used on its own — add a modifier key, or use Enter or an arrow key",
      ),
    ).toBeInTheDocument();
    expect(storedOverrides(), "after invalid composer key").toBeNull();
  });

  it("non-capturing inputs keep recording; Escape cancels", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    // Pure-modifier presses do not capture.
    const searchButton = getShortcutButton("Open search");
    await user.click(searchButton);
    fireEvent.keyDown(searchButton, { key: "Meta", metaKey: true });
    expect(searchButton).toHaveTextContent("Press shortcut…");
    expect(storedOverrides(), "after pure-modifier press").toBeNull();

    fireEvent.keyDown(searchButton, { key: "Escape" });
    expect(searchButton).toHaveTextContent("⌘K");
    expect(storedOverrides(), "after Escape cancel").toBeNull();

    // The held Enter that activated the button must not record on repeat.
    const sendButton = getShortcutButton("Send message");
    await user.click(sendButton);
    fireEvent.keyDown(sendButton, { key: "Enter", repeat: true });
    expect(sendButton).toHaveTextContent("Press shortcut…");
    expect(storedOverrides(), "after auto-repeated key").toBeNull();
  });

  it("ignores IME composition keydowns while recording", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    const button = getShortcutButton("Send message");
    await user.click(button);

    fireEvent.keyDown(button, { key: "Process", isComposing: true });
    expect(button).toHaveTextContent("Press shortcut…");
    expect(storedOverrides()).toBeNull();
  });

  it("hands recording to another row in the WebKit focus order", () => {
    renderWithProviders(<KeyboardShortcutsSettings />);

    // fireEvent.click skips userEvent's focus simulation, matching WebKit:
    // buttons only gain focus via the click handler's own focus() call, so
    // the first row's blur fires inside the second row's click batch.
    const searchButton = getShortcutButton("Open search");
    fireEvent.click(searchButton);
    expect(searchButton).toHaveTextContent("Press shortcut…");
    expect(document.activeElement).toBe(searchButton);

    const newConversationButton = getShortcutButton("New conversation");
    fireEvent.click(newConversationButton);

    expect(searchButton).toHaveTextContent("⌘K");
    expect(newConversationButton).toHaveTextContent("Press shortcut…");
  });

  it("resets a single override back to its default", async () => {
    const user = userEvent.setup();
    seedOverrides({ "navigation.search": "meta+shift+x" });
    renderWithProviders(<KeyboardShortcutsSettings />);

    expect(screen.getByText("Default: ⌘K")).toBeInTheDocument();
    expect(getShortcutButton("Open search")).toHaveTextContent("⌘⇧X");

    await user.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText("Default: ⌘K")).not.toBeInTheDocument();
    expect(getShortcutButton("Open search")).toHaveTextContent("⌘K");
  });

  it("resets all overrides and clears the storage key", async () => {
    const user = userEvent.setup();
    seedOverrides({
      "navigation.search": "meta+shift+x",
      "navigation.newConversation": "meta+shift+y",
    });
    renderWithProviders(<KeyboardShortcutsSettings />);

    const resetAll = screen.getByRole("button", { name: "Reset all" });
    expect(resetAll).toBeEnabled();

    await user.click(resetAll);

    expect(localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(/Default:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();
  });

  it("filters rows by action label and shows an empty state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeyboardShortcutsSettings />);

    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    await user.type(search, "send message");

    expect(screen.getByText("Send message")).toBeInTheDocument();
    expect(screen.queryByText("Open search")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Navigation" }),
    ).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzzz");

    expect(
      screen.getByText("No shortcuts match your search"),
    ).toBeInTheDocument();
  });
});
