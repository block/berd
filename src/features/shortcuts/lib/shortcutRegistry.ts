import { useSyncExternalStore } from "react";

import {
  keyboardShortcutFromEvent,
  normalizeKeyboardShortcut,
  type KeyboardShortcut,
  type ShortcutBinding,
} from "@/shared/keyboard/keyboardShortcut";
import { getPlatform } from "@/shared/lib/platform";

import {
  getShortcutCommand,
  SHORTCUT_CATEGORIES,
  SHORTCUT_COMMANDS,
  shortcutScopesOverlap,
  type ShortcutCommandDefinition,
  type ShortcutCommandId,
} from "./shortcutDefinitions";

export {
  getShortcutCommand,
  SHORTCUT_CATEGORIES,
  SHORTCUT_COMMANDS,
  shortcutScopesOverlap,
} from "./shortcutDefinitions";
export type {
  KnownShortcutCommandId,
  ShortcutCategory,
  ShortcutCommandDefinition,
  ShortcutCommandId,
  ShortcutScope,
} from "./shortcutDefinitions";
export type { ShortcutBinding } from "@/shared/keyboard/keyboardShortcut";

export const SHORTCUT_PREFERENCES_STORAGE_KEY = "goose:keyboard-shortcuts:v1";
export const SHORTCUT_PREFERENCES_CHANGED_EVENT =
  "goose:keyboard-shortcuts:changed";

export interface ShortcutPreferencesV1 {
  version: 1;
  overrides: Partial<Record<ShortcutCommandId, KeyboardShortcut>>;
}

export interface ShortcutPreferencesSnapshot {
  overrides: Readonly<Partial<Record<ShortcutCommandId, KeyboardShortcut>>>;
}

export interface ShortcutConflict {
  commandId: ShortcutCommandId;
  descriptionKey: string;
}

export type ShortcutSaveResult =
  | { ok: true }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "conflict"; conflict: ShortcutConflict }
  | { ok: false; reason: "storage" };

export interface ResolvedShortcutCommand {
  id: ShortcutCommandId;
  category: ShortcutCommandDefinition["category"];
  scope: ShortcutCommandDefinition["scope"];
  descriptionKey: string;
  configurable: boolean;
  discoverable: boolean;
  allowUnmodified: boolean;
  /** Effective combos: the user override when set, defaults otherwise. */
  bindings: ShortcutBinding[];
  defaultBindings: ShortcutBinding[];
  override: KeyboardShortcut | null;
}

export interface ResolvedShortcut {
  id: string;
  shortcut: KeyboardShortcut;
  descriptionKey: string;
}

export interface ResolvedShortcutGroup {
  category: ShortcutCommandDefinition["category"];
  shortcuts: ResolvedShortcut[];
}

/** Platform-primary accelerator: Cmd on macOS, Ctrl elsewhere. */
function primaryModifier(): "meta" | "ctrl" {
  return getPlatform() === "mac" ? "meta" : "ctrl";
}

function resolveModAliases(shortcut: KeyboardShortcut): KeyboardShortcut {
  return shortcut.replace(/\bmod\b/g, primaryModifier());
}

function hasNonShiftModifier(shortcut: KeyboardShortcut): boolean {
  const parts = shortcut.split("+");
  return (
    parts.includes("ctrl") || parts.includes("meta") || parts.includes("alt")
  );
}

/**
 * Normalizes a user-provided combo for a command. Commands that don't allow
 * unmodified keys additionally require ctrl/meta/alt — shift-only combos
 * would fire while typing.
 */
function normalizeOverrideShortcut(
  definition: ShortcutCommandDefinition,
  shortcut: unknown,
): KeyboardShortcut | null {
  if (typeof shortcut !== "string") return null;
  const normalized = normalizeKeyboardShortcut(
    resolveModAliases(shortcut),
    "",
    {
      allowUnmodified: definition.allowUnmodified,
    },
  );
  if (!normalized) return null;
  if (!definition.allowUnmodified && !hasNonShiftModifier(normalized)) {
    return null;
  }
  if (definition.allowUnmodified && !hasNonShiftModifier(normalized)) {
    // Unmodified (or shift-only) printable and text-editing keys would
    // hijack typing in the composer; require a real modifier or a
    // navigation/action key like enter and the arrows.
    const key = normalized.split("+").at(-1) ?? "";
    if (key.length === 1 || UNMODIFIED_TEXT_EDITING_KEYS.has(key)) {
      return null;
    }
  }
  return normalized;
}

const UNMODIFIED_TEXT_EDITING_KEYS = new Set([
  "backspace",
  "delete",
  "plus",
  "space",
  "tab",
]);

/** Defaults are trusted; they skip the override-only modifier rule. */
function normalizeDefaultBinding(
  binding: ShortcutBinding,
): ShortcutBinding | null {
  const normalized = normalizeKeyboardShortcut(
    resolveModAliases(binding.shortcut),
    "",
    { allowUnmodified: true },
  );
  if (!normalized) return null;
  return binding.code
    ? { shortcut: normalized, code: binding.code }
    : { shortcut: normalized };
}

type ShortcutOverrides = Partial<Record<ShortcutCommandId, KeyboardShortcut>>;

function normalizeDefaultBindings(
  defaults: readonly ShortcutBinding[],
): ShortcutBinding[] {
  const bindings: ShortcutBinding[] = [];
  // Aliases can collapse after mod resolution (chat.sendNow's mod+enter and
  // meta+enter on macOS) — dedupe so resolved bindings stay canonical.
  const seen = new Set<string>();
  for (const binding of defaults) {
    const normalized = normalizeDefaultBinding(binding);
    if (!normalized) continue;
    const key = normalized.code
      ? `${normalized.shortcut}\0${normalized.code}`
      : normalized.shortcut;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(normalized);
  }
  return bindings;
}

/** Static defaults are normalized once per platform modifier; handlers call
 *  into the registry on every keydown, so this stays off the hot path.
 *  Dynamic defaults (pane jump) are resolved fresh each time. */
const staticDefaultBindingsCache = new WeakMap<
  ShortcutCommandDefinition,
  { modifier: "meta" | "ctrl"; bindings: ShortcutBinding[] }
>();

function defaultBindingsOf(
  definition: ShortcutCommandDefinition,
): ShortcutBinding[] {
  if (definition.resolveDefaultBindings) {
    return normalizeDefaultBindings(definition.resolveDefaultBindings());
  }
  const modifier = primaryModifier();
  const cached = staticDefaultBindingsCache.get(definition);
  if (cached && cached.modifier === modifier) {
    return cached.bindings;
  }
  const bindings = normalizeDefaultBindings(definition.defaultBindings);
  staticDefaultBindingsCache.set(definition, { modifier, bindings });
  return bindings;
}

function effectiveBindings(
  definition: ShortcutCommandDefinition,
  overrides: ShortcutOverrides,
): ShortcutBinding[] {
  const override = definition.configurable
    ? overrides[definition.id]
    : undefined;
  if (override) {
    return [{ shortcut: override }];
  }
  const defaults = defaultBindingsOf(definition);
  if (
    definition.fallbackToStaticDefaultsOnConflict &&
    defaults.some((binding) =>
      findConflictAgainst(definition, binding.shortcut, overrides),
    )
  ) {
    // Dynamic defaults carrying user input can bypass conflict checks. Fall
    // back to static defaults rather than double-binding.
    return normalizeDefaultBindings(definition.defaultBindings);
  }
  return defaults;
}

function isCommandEnabled(definition: ShortcutCommandDefinition): boolean {
  return definition.when?.() ?? true;
}

function findConflictAgainst(
  definition: ShortcutCommandDefinition,
  shortcut: KeyboardShortcut,
  overrides: ShortcutOverrides,
): ShortcutConflict | null {
  for (const other of SHORTCUT_COMMANDS) {
    if (other.id === definition.id) continue;
    if (!isCommandEnabled(other)) continue;
    if (!shortcutScopesOverlap(definition.scope, other.scope)) continue;
    const bindings = effectiveBindings(other, overrides);
    if (bindings.some((binding) => binding.shortcut === shortcut)) {
      return { commandId: other.id, descriptionKey: other.descriptionKey };
    }
  }
  return null;
}

function sanitizeOverrides(raw: string | null): ShortcutOverrides {
  const overrides: ShortcutOverrides = {};
  if (!raw) return overrides;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return overrides;
  }
  if (typeof parsed !== "object" || parsed === null) return overrides;
  const data = parsed as { version?: unknown; overrides?: unknown };
  if (
    data.version !== 1 ||
    typeof data.overrides !== "object" ||
    data.overrides === null
  ) {
    return overrides;
  }

  const stored = data.overrides as Record<string, unknown>;
  // Normalize every stored override first (dropping unknown ids and invalid
  // combos), then drop colliding combos. Checking candidates rather than
  // defaults keeps read-time validation consistent with save-time
  // validation: a command overridden away from its default doesn't block
  // another command from claiming that freed default.
  const candidates: ShortcutOverrides = {};
  for (const definition of SHORTCUT_COMMANDS) {
    if (!definition.configurable) continue;
    const storedOverride = stored[definition.id];
    if (storedOverride === undefined) continue;
    const normalized = normalizeOverrideShortcut(definition, storedOverride);
    if (normalized) candidates[definition.id] = normalized;
  }
  return resolveOverrideConflicts(candidates);
}

/**
 * Drops colliding overrides deterministically (definition order) until the
 * set is conflict-free. Dropping a candidate revives its defaults, which
 * can invalidate an earlier-accepted override, so iterate to a fixpoint.
 */
function resolveOverrideConflicts(
  candidates: ShortcutOverrides,
): ShortcutOverrides {
  const accepted: ShortcutOverrides = { ...candidates };
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const definition of SHORTCUT_COMMANDS) {
      const candidate = accepted[definition.id];
      if (!candidate) continue;
      if (findConflictAgainst(definition, candidate, accepted)) {
        delete accepted[definition.id];
        dropped = true;
      }
    }
  }
  return accepted;
}

interface PreferencesCache {
  raw: string | null;
  snapshot: ShortcutPreferencesSnapshot;
}

let preferencesCache: PreferencesCache | null = null;

function safeReadRaw(): string | null {
  try {
    return window.localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getPreferencesSnapshot(): ShortcutPreferencesSnapshot {
  const raw = safeReadRaw();
  if (!preferencesCache || preferencesCache.raw !== raw) {
    preferencesCache = {
      raw,
      snapshot: { overrides: sanitizeOverrides(raw) },
    };
  }
  return preferencesCache.snapshot;
}

function readOverrides(): ShortcutOverrides {
  return getPreferencesSnapshot().overrides as ShortcutOverrides;
}

function notifyShortcutPreferencesChanged() {
  window.dispatchEvent(new CustomEvent(SHORTCUT_PREFERENCES_CHANGED_EVENT));
}

function writeOverrides(next: ShortcutOverrides): ShortcutSaveResult {
  // Persist only the conflict-free effective set. Removing an override can
  // revive a default that collides with another stored override (reset
  // newConversation after search claimed its freed meta+n); resolving at
  // write time makes that loss explicit and immediately visible in the UI
  // instead of leaving inert storage that a later write silently erases.
  const overrides = resolveOverrideConflicts(next);
  try {
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
    } else {
      const payload: ShortcutPreferencesV1 = { version: 1, overrides };
      window.localStorage.setItem(
        SHORTCUT_PREFERENCES_STORAGE_KEY,
        JSON.stringify(payload),
      );
    }
  } catch {
    return { ok: false, reason: "storage" };
  }
  notifyShortcutPreferencesChanged();
  return { ok: true };
}

/** Effective bindings regardless of the command's `when()` gate.
 *  `eventMatchesShortcutCommand` is the gated entry point. */
export function getShortcutBindings(
  commandId: ShortcutCommandId,
): ShortcutBinding[] {
  const definition = getShortcutCommand(commandId);
  if (!definition) return [];
  return effectiveBindings(definition, readOverrides());
}

export function eventMatchesShortcutCommand(
  event: KeyboardEvent,
  commandId: ShortcutCommandId,
): boolean {
  const definition = getShortcutCommand(commandId);
  if (!definition) return false;
  if (!isCommandEnabled(definition)) return false;
  const eventShortcut = keyboardShortcutFromEvent(event, {
    allowUnmodified: definition.allowUnmodified,
  });
  if (!eventShortcut) return false;
  return effectiveBindings(definition, readOverrides()).some(
    (binding) =>
      binding.shortcut === eventShortcut &&
      (!binding.code || event.code === binding.code),
  );
}

export function setShortcutOverride(
  commandId: ShortcutCommandId,
  shortcut: KeyboardShortcut,
): ShortcutSaveResult {
  const definition = getShortcutCommand(commandId);
  if (!definition?.configurable) return { ok: false, reason: "invalid" };
  const normalized = normalizeOverrideShortcut(definition, shortcut);
  if (!normalized) return { ok: false, reason: "invalid" };

  const overrides = readOverrides();

  // Recording a default combo clears the override so the command keeps
  // tracking its default (including every alias), and restoring a default
  // is never blocked by conflict checks. Code-pinned defaults are narrower
  // than the recorded combo, so they keep the override instead — layouts
  // whose physical key differs (e.g. "/" off the Slash key) can still
  // rebind mod+/.
  const matchedDefault = defaultBindingsOf(definition).find(
    (binding) => binding.shortcut === normalized,
  );
  if (matchedDefault && !matchedDefault.code) {
    if (!(commandId in overrides)) return { ok: true };
    const next = { ...overrides };
    delete next[commandId];
    return writeOverrides(next);
  }

  if (overrides[commandId] === normalized) return { ok: true };

  const conflict = findConflictAgainst(definition, normalized, overrides);
  if (conflict) return { ok: false, reason: "conflict", conflict };

  return writeOverrides({ ...overrides, [commandId]: normalized });
}

export function resetShortcutOverride(commandId: ShortcutCommandId): void {
  const overrides = readOverrides();
  if (!(commandId in overrides)) return;
  const next = { ...overrides };
  delete next[commandId];
  writeOverrides(next);
}

export function resetAllShortcutOverrides(): void {
  writeOverrides({});
}

export function resolveShortcutCommands(): ResolvedShortcutCommand[] {
  const overrides = readOverrides();
  return SHORTCUT_COMMANDS.filter(isCommandEnabled).map((definition) => ({
    id: definition.id,
    category: definition.category,
    scope: definition.scope,
    descriptionKey: definition.descriptionKey,
    configurable: definition.configurable,
    discoverable: definition.discoverable,
    allowUnmodified: definition.allowUnmodified === true,
    bindings: effectiveBindings(definition, overrides),
    defaultBindings: defaultBindingsOf(definition),
    override: (definition.configurable && overrides[definition.id]) || null,
  }));
}

/** Groups rendered by the keyboard shortcuts reference (Cmd+/). */
export function resolveShortcutGroups(): ResolvedShortcutGroup[] {
  const commands = resolveShortcutCommands().filter(
    (command) => command.discoverable && command.bindings.length > 0,
  );
  return SHORTCUT_CATEGORIES.map((category) => ({
    category,
    shortcuts: commands
      .filter((command) => command.category === category)
      .map((command) => ({
        id: command.id,
        shortcut: command.bindings[0].shortcut,
        descriptionKey: command.descriptionKey,
      })),
  })).filter((group) => group.shortcuts.length > 0);
}

function subscribeToPreferences(onStoreChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SHORTCUT_PREFERENCES_STORAGE_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener(SHORTCUT_PREFERENCES_CHANGED_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(
      SHORTCUT_PREFERENCES_CHANGED_EVENT,
      onStoreChange,
    );
    window.removeEventListener("storage", onStorage);
  };
}

export function useShortcutPreferences(): ShortcutPreferencesSnapshot {
  return useSyncExternalStore(
    subscribeToPreferences,
    getPreferencesSnapshot,
    getPreferencesSnapshot,
  );
}

const bindingsSnapshotCache = new Map<ShortcutCommandId, ShortcutBinding[]>();

function bindingsEqual(
  a: readonly ShortcutBinding[],
  b: readonly ShortcutBinding[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (binding, index) =>
        binding.shortcut === b[index].shortcut &&
        binding.code === b[index].code,
    )
  );
}

function getBindingsSnapshot(commandId: ShortcutCommandId): ShortcutBinding[] {
  const next = getShortcutBindings(commandId);
  const previous = bindingsSnapshotCache.get(commandId);
  if (previous && bindingsEqual(previous, next)) return previous;
  bindingsSnapshotCache.set(commandId, next);
  return next;
}

export function useShortcutBindings(
  commandId: ShortcutCommandId,
): ShortcutBinding[] {
  return useSyncExternalStore(
    subscribeToPreferences,
    () => getBindingsSnapshot(commandId),
    () => getBindingsSnapshot(commandId),
  );
}
