import {
  createTextFile,
  getHomeDir,
  pathExists,
  readTextFile,
  recordMeHistory,
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
 * So this file is a mirror, not a second source of truth. Berd writes it when
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

/**
 * Mirrors Berd's switch into the store, preserving any keys another host put
 * there. Never throws: failing to write the mirror must not stop the toggle
 * from working inside Berd.
 */
export async function writeMemoryPolicy(enabled: boolean): Promise<void> {
  const path = await policyPath();
  if (!path) return;
  try {
    const existing = (await readMemoryPolicy()) ?? {};
    const next = { ...existing, enabled };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    if (await pathExists(path)) {
      await writeTextFile(path, body);
    } else {
      await createTextFile(path, body);
    }
    await recordMeHistory(
      path,
      "policy",
      enabled ? "Memory turned on" : "Memory turned off",
    ).catch(() => {});
  } catch (error) {
    console.warn("[me:policy] failed to mirror the memory switch", error);
  }
}
