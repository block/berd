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

function normalizeKey(key: string): string {
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey === " ") return "space";
  if (normalizedKey === "esc") return "escape";
  return normalizedKey;
}

export function normalizeKeyboardShortcut(
  shortcut: unknown,
  fallback: string,
): KeyboardShortcut {
  if (typeof shortcut !== "string") {
    return fallback;
  }

  const parts = shortcut
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .split("+")
    .filter(Boolean);
  const key = normalizeKey(parts.at(-1) ?? "");
  const modifiers = new Set<Modifier>();

  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return fallback;
    modifiers.add(modifier);
  }

  if (modifiers.size === 0 || !key || MODIFIER_ALIASES[key]) {
    return fallback;
  }

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");
}

export function keyboardShortcutFromEvent(
  event: KeyboardEvent,
): KeyboardShortcut | null {
  const key = normalizeKey(event.key);
  if (!key || MODIFIER_ALIASES[key]) {
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

  if (modifiers.length === 0) {
    return null;
  }

  return [...modifiers, key].join("+");
}

export function keyboardEventMatchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
): boolean {
  return keyboardShortcutFromEvent(event) === shortcut;
}

export function formatKeyboardShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      const modifierLabel = MODIFIER_LABELS[part as Modifier];
      if (modifierLabel) return modifierLabel;
      if (part === "space") return "Space";
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}
