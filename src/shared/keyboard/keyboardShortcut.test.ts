import { describe, expect, it } from "vitest";

import {
  keyboardEventMatchesShortcut,
  keyboardShortcutDisplayParts,
  keyboardShortcutFromEvent,
  normalizeKeyboardShortcut,
} from "./keyboardShortcut";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("normalizeKeyboardShortcut", () => {
  it("normalizes casing, whitespace, aliases, and modifier order", () => {
    expect(normalizeKeyboardShortcut("Cmd + K", "fallback")).toBe("meta+k");
    expect(normalizeKeyboardShortcut("shift+ctrl+k", "fallback")).toBe(
      "ctrl+shift+k",
    );
    expect(normalizeKeyboardShortcut("option+command+P", "fallback")).toBe(
      "meta+alt+p",
    );
    expect(normalizeKeyboardShortcut("control+Esc", "fallback")).toBe(
      "ctrl+escape",
    );
  });

  it("treats a doubled separator as the plus key", () => {
    expect(normalizeKeyboardShortcut("meta++", "fallback")).toBe("meta+plus");
    expect(normalizeKeyboardShortcut("ctrl+shift++", "fallback")).toBe(
      "ctrl+shift+plus",
    );
  });

  it("rejects a single dangling separator", () => {
    expect(normalizeKeyboardShortcut("ctrl+", "fallback")).toBe("fallback");
  });

  it("rejects dead, IME, and lock keys", () => {
    // Dead keys report "Dead" for every variant (a stored "alt+dead" combo
    // would match all of them); Process/locks are stateful, not chordable.
    for (const combo of [
      "alt+dead",
      "process",
      "capslock",
      "ctrl+numlock",
      "altgraph",
    ]) {
      expect(
        normalizeKeyboardShortcut(combo, "fallback", { allowUnmodified: true }),
        combo,
      ).toBe("fallback");
    }
  });

  it("does not treat mod as an alias", () => {
    expect(normalizeKeyboardShortcut("mod+k", "fallback")).toBe("fallback");
  });

  it("rejects pure-modifier combos", () => {
    expect(normalizeKeyboardShortcut("ctrl", "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut("shift", "fallback")).toBe("fallback");
    expect(
      normalizeKeyboardShortcut("ctrl+shift", "fallback", {
        allowUnmodified: true,
      }),
    ).toBe("fallback");
  });

  it("rejects garbage and non-string input", () => {
    expect(normalizeKeyboardShortcut("foo+k", "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut("", "fallback")).toBe("fallback");
    expect(
      normalizeKeyboardShortcut("", "fallback", { allowUnmodified: true }),
    ).toBe("fallback");
    expect(normalizeKeyboardShortcut(42, "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut(null, "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut(undefined, "fallback")).toBe("fallback");
  });

  it("rejects modifier-less combos unless allowUnmodified is set", () => {
    expect(normalizeKeyboardShortcut("enter", "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut("arrowup", "fallback")).toBe("fallback");
    expect(normalizeKeyboardShortcut(",", "fallback")).toBe("fallback");

    const allow = { allowUnmodified: true };
    expect(normalizeKeyboardShortcut("enter", "fallback", allow)).toBe("enter");
    expect(normalizeKeyboardShortcut("arrowup", "fallback", allow)).toBe(
      "arrowup",
    );
    expect(normalizeKeyboardShortcut(",", "fallback", allow)).toBe(",");
  });

  it("accepts shift-modified combos without allowUnmodified", () => {
    expect(normalizeKeyboardShortcut("shift+enter", "fallback")).toBe(
      "shift+enter",
    );
  });
});

describe("keyboardShortcutFromEvent", () => {
  it("converts modified events into normalized combos", () => {
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "k", metaKey: true })),
    ).toBe("meta+k");
    expect(
      keyboardShortcutFromEvent(
        keyEvent({ key: "P", ctrlKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBe("ctrl+alt+shift+p");
  });

  it("returns null for pure-modifier keydowns", () => {
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "Meta", metaKey: true })),
    ).toBeNull();
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "Shift", shiftKey: true })),
    ).toBeNull();
  });

  it("returns null for modifier-less events unless allowUnmodified is set", () => {
    expect(keyboardShortcutFromEvent(keyEvent({ key: "Enter" }))).toBeNull();
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "Enter" }), {
        allowUnmodified: true,
      }),
    ).toBe("enter");
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "ArrowUp" }), {
        allowUnmodified: true,
      }),
    ).toBe("arrowup");
  });

  it("maps the plus key to plus", () => {
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "+", metaKey: true })),
    ).toBe("meta+plus");
  });

  it("maps a space key event to space", () => {
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: " ", altKey: true })),
    ).toBe("alt+space");
  });

  it("returns null for dead, IME, and lock keys", () => {
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "Dead", altKey: true })),
    ).toBeNull();
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "Process" }), {
        allowUnmodified: true,
      }),
    ).toBeNull();
  });
});

describe("keyboardEventMatchesShortcut", () => {
  it("matches normalized combos", () => {
    const event = keyEvent({ key: "k", metaKey: true });
    expect(keyboardEventMatchesShortcut(event, "meta+k")).toBe(true);
    expect(keyboardEventMatchesShortcut(event, "meta+j")).toBe(false);
    expect(keyboardEventMatchesShortcut(event, "ctrl+k")).toBe(false);
  });

  it("matches unmodified combos only with allowUnmodified", () => {
    const event = keyEvent({ key: "Enter" });
    expect(keyboardEventMatchesShortcut(event, "enter")).toBe(false);
    expect(
      keyboardEventMatchesShortcut(event, "enter", { allowUnmodified: true }),
    ).toBe(true);
  });
});

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

  it("renders shift+enter with words off macOS", () => {
    expect(keyboardShortcutDisplayParts("shift+enter", false)).toEqual([
      "Shift",
      "↩",
    ]);
  });

  it("renders the plus key as +", () => {
    expect(keyboardShortcutDisplayParts("meta+plus", true)).toEqual(["⌘", "+"]);
    expect(keyboardShortcutDisplayParts("meta+plus", false)).toEqual([
      "Meta",
      "+",
    ]);
  });

  it("passes punctuation keys through", () => {
    expect(keyboardShortcutDisplayParts("meta+/", true)).toEqual(["⌘", "/"]);
    expect(keyboardShortcutDisplayParts("meta+,", false)).toEqual([
      "Meta",
      ",",
    ]);
  });
});
