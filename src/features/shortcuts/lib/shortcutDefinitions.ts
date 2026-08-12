import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import type { ShortcutBinding } from "@/shared/keyboard/keyboardShortcut";
import { getPlatform } from "@/shared/lib/platform";

export const SHORTCUT_CATEGORIES = [
  "navigation",
  "chat",
  "view",
  "help",
] as const;

export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

export type KnownShortcutCommandId =
  | "navigation.search"
  | "navigation.newConversation"
  | "navigation.back"
  | "navigation.forward"
  | "navigation.closeSession"
  | "navigation.openSettings"
  | "navigation.paneJump"
  | "navigation.globalShortcut"
  | "session.quickSwitch"
  | "session.next"
  | "session.previous"
  | "chat.archiveSession"
  | "chat.findInConversation"
  | "chat.toggleVoiceDictation"
  | "chat.sendMessage"
  | "chat.insertNewline"
  | "chat.sendNow"
  | "chat.recallLastMessage"
  | "view.toggleSidebar"
  | "view.toggleTerminal"
  | "terminal.newTab"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.toggleDesignSystemInspector"
  | "view.toggleDesignSystemInspectorMode"
  | "help.shortcuts";

/** Fixed/internal command ids stay open-ended so component-level entries
 *  don't have to widen the union. */
export type ShortcutCommandId = KnownShortcutCommandId | (string & {});

export type ShortcutScope =
  | "global"
  | "chat"
  | "composer"
  | "terminal"
  | "chat-search"
  | "component";

/** Scope nesting used for conflict checks: a combo collides when both
 *  commands can be live for the same focused element. Siblings (e.g.
 *  composer vs. chat-search, component vs. composer) never collide. */
const SCOPE_PARENTS: Record<ShortcutScope, ShortcutScope | null> = {
  global: null,
  chat: "global",
  composer: "chat",
  terminal: "chat",
  "chat-search": "chat",
  component: "global",
};

function scopeAncestors(scope: ShortcutScope): Set<ShortcutScope> {
  const ancestors = new Set<ShortcutScope>();
  let current = SCOPE_PARENTS[scope];
  while (current) {
    ancestors.add(current);
    current = SCOPE_PARENTS[current];
  }
  return ancestors;
}

export function shortcutScopesOverlap(
  a: ShortcutScope,
  b: ShortcutScope,
): boolean {
  if (a === b) return true;
  return scopeAncestors(a).has(b) || scopeAncestors(b).has(a);
}

const DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT = "ctrl+;";
const DEFAULT_GLOBAL_SHORTCUT = "alt+space";

export interface ShortcutCommandDefinition {
  id: ShortcutCommandId;
  category: ShortcutCategory;
  scope: ShortcutScope;
  /**
   * Static default combos. "mod" resolves to the platform-primary
   * accelerator: meta (Cmd) on macOS, ctrl elsewhere.
   */
  defaultBindings: readonly ShortcutBinding[];
  /** Dynamic defaults take precedence over `defaultBindings` when present. */
  resolveDefaultBindings?: () => readonly ShortcutBinding[];
  /** Fall back to static defaults if a dynamic binding collides with an
   *  override. Use only when the dynamic binding comes from user input. */
  fallbackToStaticDefaultsOnConflict?: boolean;
  /** Key in the "shortcuts" i18n namespace describing the action. */
  descriptionKey: string;
  /** Editable from Keyboard Shortcuts settings. */
  configurable: boolean;
  /** Listed in the keyboard shortcuts reference dialog. */
  discoverable: boolean;
  /** Combos may omit ctrl/meta/alt/shift (composer and component keys). */
  allowUnmodified?: boolean;
  /** Hide and disable the command while this returns false. */
  when?: () => boolean;
}

/**
 * Every app-owned keyboard handler is represented here. Configurable
 * commands can be rebound from Settings → Keyboard shortcuts; fixed
 * commands (configurable: false) document component-level keys so user
 * overrides can be conflict-checked against them, but their behavior
 * stays owned by the component (ARIA/native semantics).
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  // Navigation
  {
    id: "navigation.search",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+k" }],
    descriptionKey: "actions.search",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.newConversation",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+n" }],
    descriptionKey: "actions.newConversation",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.back",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "meta+[" }],
    resolveDefaultBindings: () =>
      getPlatform() === "mac"
        ? [{ shortcut: "meta+[" }]
        : [{ shortcut: "alt+arrowleft" }],
    descriptionKey: "actions.back",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.forward",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "meta+]" }],
    resolveDefaultBindings: () =>
      getPlatform() === "mac"
        ? [{ shortcut: "meta+]" }]
        : [{ shortcut: "alt+arrowright" }],
    descriptionKey: "actions.forward",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.closeSession",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+w" }],
    descriptionKey: "actions.closeSession",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.openSettings",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+," }],
    descriptionKey: "actions.openSettings",
    configurable: true,
    discoverable: true,
  },
  {
    id: "session.quickSwitch",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+p" }],
    descriptionKey: "actions.quickSwitch",
    configurable: true,
    discoverable: true,
  },
  {
    id: "session.next",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "ctrl+tab" }],
    descriptionKey: "actions.nextSession",
    configurable: true,
    discoverable: true,
  },
  {
    id: "session.previous",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: "ctrl+shift+tab" }],
    descriptionKey: "actions.previousSession",
    configurable: true,
    discoverable: true,
  },
  {
    id: "navigation.globalShortcut",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: DEFAULT_GLOBAL_SHORTCUT }],
    descriptionKey: "actions.globalShortcut",
    configurable: true,
    discoverable: true,
    when: () => getPlatform() === "mac",
  },
  {
    id: "navigation.paneJump",
    category: "navigation",
    scope: "global",
    defaultBindings: [{ shortcut: DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT }],
    descriptionKey: "actions.paneJump",
    configurable: true,
    discoverable: true,
  },
  // Chat
  {
    id: "chat.archiveSession",
    category: "chat",
    scope: "chat",
    defaultBindings: [{ shortcut: "mod+e" }],
    descriptionKey: "actions.archiveSession",
    configurable: true,
    discoverable: true,
  },
  {
    id: "chat.findInConversation",
    category: "chat",
    scope: "chat",
    defaultBindings: [{ shortcut: "mod+f" }],
    descriptionKey: "actions.findInConversation",
    configurable: true,
    discoverable: true,
  },
  {
    id: "chat.toggleVoiceDictation",
    category: "chat",
    scope: "composer",
    defaultBindings: [{ shortcut: "mod+d" }],
    descriptionKey: "actions.toggleVoiceDictation",
    configurable: true,
    discoverable: true,
  },
  {
    id: "chat.sendMessage",
    category: "chat",
    scope: "composer",
    defaultBindings: [{ shortcut: "enter" }],
    descriptionKey: "actions.sendMessage",
    configurable: true,
    discoverable: true,
    allowUnmodified: true,
  },
  {
    id: "chat.insertNewline",
    category: "chat",
    scope: "composer",
    defaultBindings: [{ shortcut: "shift+enter" }],
    descriptionKey: "actions.insertNewline",
    configurable: true,
    discoverable: true,
    allowUnmodified: true,
  },
  {
    id: "chat.sendNow",
    category: "chat",
    scope: "composer",
    // Both accelerators send on every platform (pre-registry behavior);
    // the platform-primary alias renders as the display binding.
    defaultBindings: [
      { shortcut: "mod+enter" },
      { shortcut: "ctrl+enter" },
      { shortcut: "meta+enter" },
    ],
    descriptionKey: "actions.sendNow",
    configurable: true,
    discoverable: true,
  },
  {
    id: "chat.recallLastMessage",
    category: "chat",
    scope: "composer",
    defaultBindings: [{ shortcut: "arrowup" }],
    descriptionKey: "actions.recallLastMessage",
    configurable: true,
    discoverable: true,
    allowUnmodified: true,
  },
  // View
  {
    id: "view.toggleSidebar",
    category: "view",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+b" }],
    descriptionKey: "actions.toggleSidebar",
    configurable: true,
    discoverable: true,
  },
  {
    id: "view.toggleTerminal",
    category: "view",
    scope: "chat",
    defaultBindings: [{ shortcut: "mod+j" }],
    descriptionKey: "actions.toggleTerminal",
    configurable: true,
    discoverable: true,
  },
  {
    id: "terminal.newTab",
    category: "view",
    scope: "terminal",
    defaultBindings: [{ shortcut: "mod+t" }],
    descriptionKey: "actions.newTerminalTab",
    configurable: true,
    discoverable: true,
  },
  {
    id: "view.zoomIn",
    category: "view",
    scope: "global",
    defaultBindings: [
      { shortcut: "mod+=" },
      { shortcut: "mod+plus" },
      { shortcut: "mod+shift+plus" },
    ],
    descriptionKey: "actions.zoomIn",
    configurable: true,
    discoverable: true,
  },
  {
    id: "view.zoomOut",
    category: "view",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+-" }],
    descriptionKey: "actions.zoomOut",
    configurable: true,
    discoverable: true,
  },
  {
    id: "view.zoomReset",
    category: "view",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+0" }],
    descriptionKey: "actions.zoomReset",
    configurable: true,
    discoverable: true,
  },
  {
    id: "view.toggleDesignSystemInspector",
    category: "view",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+shift+d" }],
    descriptionKey: "actions.toggleDesignSystemInspector",
    configurable: true,
    discoverable: true,
    when: isDesignSystemExplorerEnabled,
  },
  {
    id: "view.toggleDesignSystemInspectorMode",
    category: "view",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+i" }],
    descriptionKey: "actions.toggleDesignSystemInspectorMode",
    configurable: true,
    discoverable: true,
    when: isDesignSystemExplorerEnabled,
  },
  // Help. AppShell matches this before its keyboard-owning-layer guard so
  // the combo can close the dialog it opens.
  {
    id: "help.shortcuts",
    category: "help",
    scope: "global",
    defaultBindings: [{ shortcut: "mod+/", code: "Slash" }],
    descriptionKey: "actions.showShortcuts",
    configurable: true,
    discoverable: true,
  },
  // Fixed: mention menu (ChatInput)
  {
    id: "chat.mention.close",
    category: "chat",
    scope: "component",
    defaultBindings: [{ shortcut: "escape" }],
    descriptionKey: "actions.mentionClose",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.mention.next",
    category: "chat",
    scope: "component",
    defaultBindings: [{ shortcut: "arrowdown" }],
    descriptionKey: "actions.mentionNext",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.mention.previous",
    category: "chat",
    scope: "component",
    defaultBindings: [{ shortcut: "arrowup" }],
    descriptionKey: "actions.mentionPrevious",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.mention.confirm",
    category: "chat",
    scope: "component",
    defaultBindings: [{ shortcut: "enter" }],
    descriptionKey: "actions.mentionConfirm",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.mention.acceptSuggestion",
    category: "chat",
    scope: "component",
    defaultBindings: [{ shortcut: "tab" }],
    descriptionKey: "actions.mentionAcceptSuggestion",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  // Fixed: transcript search bar (ChatSearchBar)
  {
    id: "chat.search.close",
    category: "chat",
    scope: "chat-search",
    defaultBindings: [{ shortcut: "escape" }],
    descriptionKey: "actions.searchClose",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.search.next",
    category: "chat",
    scope: "chat-search",
    defaultBindings: [
      { shortcut: "enter" },
      { shortcut: "arrowdown" },
      { shortcut: "ctrl+n" },
    ],
    descriptionKey: "actions.searchNext",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  {
    id: "chat.search.previous",
    category: "chat",
    scope: "chat-search",
    defaultBindings: [
      { shortcut: "shift+enter" },
      { shortcut: "arrowup" },
      { shortcut: "ctrl+p" },
    ],
    descriptionKey: "actions.searchPrevious",
    configurable: false,
    discoverable: false,
    allowUnmodified: true,
  },
  // Standard accessibility/widget keys (dialog Escape, card Enter/Space,
  // list/carousel arrows, the provider tag editor's Enter/comma) stay with
  // their components in the "component" scope. They are deliberately not
  // listed here: they are unmodified keys, and configurable commands either
  // require a real modifier or live in scopes that never overlap
  // "component", so no entry could ever participate in a conflict.
];

const COMMANDS_BY_ID = new Map(
  SHORTCUT_COMMANDS.map((command) => [command.id, command]),
);

export function getShortcutCommand(
  id: ShortcutCommandId,
): ShortcutCommandDefinition | undefined {
  return COMMANDS_BY_ID.get(id);
}
