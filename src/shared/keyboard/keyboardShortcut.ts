const MODIFIER_ORDER = ["ctrl", "meta", "alt", "shift"] as const;
const MODIFIER_LABELS = {
  ctrl: "Ctrl",
  meta: "Meta",
  alt: "Alt",
  shift: "Shift",
} as const;

type Modifier = (typeof MODIFIER_ORDER)[number];
export type KeyboardShortcut = string;

const MODIFIER_ALIASES: Record<string, Modifier | undefined> = {
  alt: "alt",
  cmd: "meta",
  command: "meta",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  option: "alt",
  shift: "shift",
};

export interface KeyboardShortcutOptions {
  /** Permit combos without any modifier (e.g. "enter", "arrowup"). */
  allowUnmodified?: boolean;
}

/** A single matchable combo. `shortcut` must be normalized with any "mod"
 *  alias already resolved; `code` additionally pins the physical key
 *  (KeyboardEvent.code), e.g. "Slash" so layouts where "/" moves around
 *  don't hijack unrelated keys. */
export interface ShortcutBinding {
  shortcut: KeyboardShortcut;
  code?: string;
}

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey === "esc") return "escape";
  if (normalizedKey === "+") return "plus";
  return normalizedKey;
}

/** Keys that can't serve as a binding's final key: dead keys (macOS
 *  Option+E etc.) report "Dead" for every variant so a recorded combo would
 *  match all of them, and lock/IME/system keys are stateful rather than
 *  chordable. */
const UNBINDABLE_KEYS = new Set([
  "altgraph",
  "capslock",
  "dead",
  "fn",
  "fnlock",
  "numlock",
  "process",
  "scrolllock",
]);

function isUnbindableKey(key: string): boolean {
  return UNBINDABLE_KEYS.has(key);
}

export function normalizeKeyboardShortcut(
  shortcut: unknown,
  fallback: string,
  options?: KeyboardShortcutOptions,
): KeyboardShortcut {
  if (typeof shortcut !== "string") {
    return fallback;
  }

  const collapsed = shortcut.trim().toLowerCase().replace(/\s+/g, "");
  const parts = collapsed.split("+").filter(Boolean);
  // A doubled separator means the key itself is "+" (e.g. "mod++"); a
  // single dangling "+" (e.g. "ctrl+") stays invalid and falls back.
  const endsWithPlusKey = collapsed === "+" || collapsed.endsWith("++");
  const key = endsWithPlusKey ? "plus" : normalizeKey(parts.at(-1) ?? "");
  const modifierParts = endsWithPlusKey ? parts : parts.slice(0, -1);
  const modifiers = new Set<Modifier>();

  for (const part of modifierParts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return fallback;
    modifiers.add(modifier);
  }

  if (!key || MODIFIER_ALIASES[key] || isUnbindableKey(key)) {
    return fallback;
  }

  if (modifiers.size === 0 && !options?.allowUnmodified) {
    return fallback;
  }

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");
}

export function keyboardShortcutFromEvent(
  event: KeyboardEvent,
  options?: KeyboardShortcutOptions,
): KeyboardShortcut | null {
  const key = normalizeKey(event.key);
  if (!key || MODIFIER_ALIASES[key] || isUnbindableKey(key)) {
    return null;
  }

  const modifiers = MODIFIER_ORDER.filter((modifier) => {
    switch (modifier) {
      case "ctrl":
        return event.ctrlKey;
      case "meta":
        return event.metaKey;
      case "alt":
        return event.altKey;
      case "shift":
        return event.shiftKey;
      default:
        return false;
    }
  });

  if (modifiers.length === 0 && !options?.allowUnmodified) {
    return null;
  }

  return [...modifiers, key].join("+");
}

export function keyboardEventMatchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
  options?: KeyboardShortcutOptions,
): boolean {
  return keyboardShortcutFromEvent(event, options) === shortcut;
}

const MAC_MODIFIER_SYMBOLS: Record<Modifier, string> = {
  ctrl: "⌃",
  meta: "⌘",
  alt: "⌥",
  shift: "⇧",
};

const DISPLAY_KEY_LABELS: Record<string, string> = {
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  backspace: "⌫",
  enter: "↩",
  escape: "Esc",
  plus: "+",
  space: "Space",
};

function capitalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatDisplayKey(key: string): string {
  return DISPLAY_KEY_LABELS[key] ?? capitalizeKey(key);
}

/** Formats a normalized shortcut into per-key display labels,
 *  using mac symbols (⌘, ⌥, …) when `isMac` is true. */
export function keyboardShortcutDisplayParts(
  shortcut: string,
  isMac: boolean,
): string[] {
  return shortcut.split("+").map((part) => {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) {
      return isMac ? MAC_MODIFIER_SYMBOLS[modifier] : MODIFIER_LABELS[modifier];
    }
    return formatDisplayKey(part);
  });
}
