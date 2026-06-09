import {
  PANE_JUMP_NAVIGATION_EXPERIMENT_ID,
  DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT,
} from "@/features/experiments/experimentDefinitions";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import {
  normalizeKeyboardShortcut,
  type KeyboardShortcut,
} from "@/shared/keyboard/keyboardShortcut";
import { getPlatform } from "@/shared/lib/platform";

export const SHORTCUT_CATEGORIES = [
  "navigation",
  "chat",
  "view",
  "help",
] as const;

export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

export interface ShortcutDefinition {
  id: string;
  category: ShortcutCategory;
  /**
   * Normalized combo (see keyboardShortcut.ts), e.g. "mod+k". The "mod"
   * modifier resolves to the platform-primary accelerator: meta (Cmd) on
   * macOS, ctrl elsewhere. Use explicit "meta"/"ctrl" only for shortcuts
   * that genuinely differ from that convention.
   */
  shortcut: KeyboardShortcut | (() => KeyboardShortcut);
  /** Key in the "shortcuts" i18n namespace describing the action. */
  descriptionKey: string;
  /** Hide the entry from the reference when this returns false. */
  when?: () => boolean;
}

function paneJumpExperiment() {
  return getExperiment(PANE_JUMP_NAVIGATION_EXPERIMENT_ID);
}

/**
 * Declarative list rendered by the keyboard shortcuts reference (Cmd+?).
 *
 * To make a new shortcut discoverable: keep its handler wherever it lives,
 * add one entry here, and add its description to
 * src/shared/i18n/locales/{en,es}/shortcuts.json.
 */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  // Navigation
  {
    id: "search",
    category: "navigation",
    shortcut: "mod+k",
    descriptionKey: "actions.search",
  },
  {
    id: "new-conversation",
    category: "navigation",
    shortcut: "mod+n",
    descriptionKey: "actions.newConversation",
  },
  {
    id: "close-session",
    category: "navigation",
    shortcut: "mod+w",
    descriptionKey: "actions.closeSession",
  },
  {
    id: "settings",
    category: "navigation",
    shortcut: "mod+,",
    descriptionKey: "actions.openSettings",
  },
  {
    id: "pane-jump",
    category: "navigation",
    shortcut: () =>
      normalizeKeyboardShortcut(
        paneJumpExperiment()?.config.shortcut,
        DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT,
      ),
    descriptionKey: "actions.paneJump",
    when: () => paneJumpExperiment()?.enabled === true,
  },
  // Chat
  {
    id: "find-in-conversation",
    category: "chat",
    shortcut: "mod+f",
    descriptionKey: "actions.findInConversation",
  },
  {
    id: "send-message",
    category: "chat",
    shortcut: "enter",
    descriptionKey: "actions.sendMessage",
  },
  {
    id: "newline",
    category: "chat",
    shortcut: "shift+enter",
    descriptionKey: "actions.insertNewline",
  },
  // View
  {
    id: "toggle-sidebar",
    category: "view",
    shortcut: "mod+b",
    descriptionKey: "actions.toggleSidebar",
  },
  {
    id: "toggle-terminal",
    category: "view",
    shortcut: "mod+j",
    descriptionKey: "actions.toggleTerminal",
  },
  {
    id: "new-terminal-tab",
    category: "view",
    shortcut: "mod+t",
    descriptionKey: "actions.newTerminalTab",
  },
  {
    id: "zoom-in",
    category: "view",
    shortcut: "mod+=",
    descriptionKey: "actions.zoomIn",
  },
  {
    id: "zoom-out",
    category: "view",
    shortcut: "mod+-",
    descriptionKey: "actions.zoomOut",
  },
  {
    id: "zoom-reset",
    category: "view",
    shortcut: "mod+0",
    descriptionKey: "actions.zoomReset",
  },
  // Help
  {
    id: "shortcuts-reference",
    category: "help",
    shortcut: "mod+/",
    descriptionKey: "actions.showShortcuts",
  },
];

export interface ResolvedShortcut {
  id: string;
  shortcut: KeyboardShortcut;
  descriptionKey: string;
}

export interface ResolvedShortcutGroup {
  category: ShortcutCategory;
  shortcuts: ResolvedShortcut[];
}

/** Platform-primary accelerator: Cmd on macOS, Ctrl elsewhere. */
export function primaryModifier(): "meta" | "ctrl" {
  return getPlatform() === "mac" ? "meta" : "ctrl";
}

function resolveCombo(definition: ShortcutDefinition): KeyboardShortcut {
  const combo =
    typeof definition.shortcut === "function"
      ? definition.shortcut()
      : definition.shortcut;
  return combo.replace(/\bmod\b/, primaryModifier());
}

export function resolveShortcutGroups(): ResolvedShortcutGroup[] {
  return SHORTCUT_CATEGORIES.map((category) => ({
    category,
    shortcuts: SHORTCUT_DEFINITIONS.filter(
      (definition) =>
        definition.category === category && (definition.when?.() ?? true),
    ).map((definition) => ({
      id: definition.id,
      shortcut: resolveCombo(definition),
      descriptionKey: definition.descriptionKey,
    })),
  })).filter((group) => group.shortcuts.length > 0);
}
