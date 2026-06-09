import { describe, expect, it } from "vitest";

import { keyboardShortcutDisplayParts } from "./keyboardShortcut";

describe("keyboardShortcutDisplayParts", () => {
  it("uses modifier symbols on macOS", () => {
    expect(keyboardShortcutDisplayParts("meta+k", true)).toEqual(["⌘", "K"]);
    expect(keyboardShortcutDisplayParts("ctrl+alt+shift+p", true)).toEqual([
      "⌃",
      "⌥",
      "⇧",
      "P",
    ]);
  });

  it("uses modifier words off macOS", () => {
    expect(keyboardShortcutDisplayParts("ctrl+k", false)).toEqual([
      "Ctrl",
      "K",
    ]);
    expect(keyboardShortcutDisplayParts("ctrl+shift+f", false)).toEqual([
      "Ctrl",
      "Shift",
      "F",
    ]);
  });

  it("formats special keys with display labels", () => {
    expect(keyboardShortcutDisplayParts("shift+enter", true)).toEqual([
      "⇧",
      "↩",
    ]);
    expect(keyboardShortcutDisplayParts("meta+backspace", true)).toEqual([
      "⌘",
      "⌫",
    ]);
    expect(keyboardShortcutDisplayParts("meta+arrowup", true)).toEqual([
      "⌘",
      "↑",
    ]);
    expect(keyboardShortcutDisplayParts("ctrl+escape", false)).toEqual([
      "Ctrl",
      "Esc",
    ]);
    expect(keyboardShortcutDisplayParts("ctrl+space", false)).toEqual([
      "Ctrl",
      "Space",
    ]);
  });

  it("capitalizes multi-character keys without labels", () => {
    expect(keyboardShortcutDisplayParts("meta+tab", false)).toEqual([
      "Meta",
      "Tab",
    ]);
  });
});
