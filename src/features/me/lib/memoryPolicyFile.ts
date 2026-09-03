import {
  createTextFile,
  getHomeDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@/shared/api/system";

/**
 * `~/.me/policy.json` — the on/off switch, written into the store.
 *
 * Berd's own switch lives in app preferences, which is right for Berd but
 * invisible to anything else. The me.md protocol puts policy in the store so
 * that *any* host serving the same person honors the same decision: if this
 * says off, a conforming host behaves as if the store is absent.
 *
 * This is the source of truth. Berd writes it when
 * the user flips the switch and reads it on load, which means a person who
 * turns memory off in another tool (or by hand) has that respected here too.
 *
 * Best-effort throughout: the switch must work even if the store is
 * read-only, missing, or holds a policy file written by someone else in a
 * shape we don't recognize.
 */

const POLICY_FILE = "policy.json";

/** The protocol names the file, not its schema. Keep ours minimal and
 *  additive so another host's keys survive a round trip through Berd. */
interface MemoryPolicy {
  enabled: boolean;
  [key: string]: unknown;
}

async function policyPath(): Promise<string | null> {
  try {
    const homeDir = await getHomeDir();
    return `${homeDir}/.me/${POLICY_FILE}`;
  } catch {
    return null;
  }
}

/**
 * Reads the store's policy. Returns null when there's no policy file at all,
 * which is different from `{ enabled: false }` — absence means "no opinion",
 * so Berd's own preference decides.
 */
export async function readMemoryPolicy(): Promise<MemoryPolicy | null> {
  const path = await policyPath();
  if (!path) return null;
  try {
    if (!(await pathExists(path))) return null;
    const payload = await readTextFile(path);
    const parsed = JSON.parse(payload.contents) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const policy = parsed as Partial<MemoryPolicy>;
    if (typeof policy.enabled !== "boolean") return null;
    return policy as MemoryPolicy;
  } catch {
    return null;
  }
}

/** Canonical memory-enable decision. Missing or malformed policy defaults on. */
export async function isMemoryEnabledByPolicy(): Promise<boolean> {
  return (await readMemoryPolicy())?.enabled ?? true;
}

/**
 * Writes the canonical switch into the store, preserving any keys another host put
 * there. Returns false when the user-owned policy could not be changed; callers
 * must not present a state that differs from this file.
 */
export async function writeMemoryPolicy(enabled: boolean): Promise<boolean> {
  const path = await policyPath();
  if (!path) return false;
  try {
    const existing = (await readMemoryPolicy()) ?? {};
    const next = { ...existing, enabled };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    if (await pathExists(path)) {
      await writeTextFile(path, body);
    } else {
      await createTextFile(path, body);
    }
    return true;
  } catch (error) {
    console.warn("[me:policy] failed to write the memory switch", error);
    return false;
  }
}
