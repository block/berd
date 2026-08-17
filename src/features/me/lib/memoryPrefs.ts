/**
 * The memory on/off switch. When off, Berd stops reading and writing the
 * user's memory files entirely: no preamble injection, no publication to
 * other tools' agent files, no agent proposals. The files themselves are
 * never touched by the toggle — "off" pauses, it never erases. Deleting
 * memory is a separate, explicit act that belongs to the user.
 *
 * Default is on: memory is a launch feature, and the toggle exists so that
 * not having it is a first-class choice.
 */

const STORAGE_KEY = "berd:memory";

export interface MemoryPrefs {
  enabled: boolean;
}

const DEFAULTS: MemoryPrefs = {
  enabled: true,
};

export function getMemoryPrefs(): MemoryPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MemoryPrefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setMemoryPrefs(prefs: Partial<MemoryPrefs>): void {
  try {
    const current = getMemoryPrefs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch {
    // localStorage unavailable in some environments
  }
}

export function isMemoryEnabled(): boolean {
  return getMemoryPrefs().enabled;
}
