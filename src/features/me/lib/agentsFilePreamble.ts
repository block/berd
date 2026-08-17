import { getHomeDir, pathExists, readTextFile } from "@/shared/api/system";
import { withoutBerdManagedBlock } from "./mePublish";

/**
 * The user's own global agents file (`~/.agents/AGENTS.md`), injected into
 * every Berd session as user instructions.
 *
 * Berd publishes the memory block *into* this file for other tools to
 * read — but participating in a convention means reading it too, not just
 * using it as a distribution channel. Someone arriving at Berd with an
 * existing agents file should have a good first session before any memory
 * exists.
 *
 * Two boundaries keep this sane:
 * - Our own managed block is stripped before injection: sessions already
 *   receive the me file once via the preamble, and twice would be noise.
 * - This is independent of the memory toggle. The agents file is the
 *   user's instructions, not Berd's memory — turning memory off must not
 *   silence what they wrote themselves.
 */

export const USER_AGENTS_FILE_MAX_CHARS = 16_000;

const TRUNCATION_NOTE = "\n\n[…agents file truncated for length]";

export function buildAgentsFilePreamble(
  contents: string,
  displayPath: string,
): string | null {
  const withoutOurs = withoutBerdManagedBlock(contents).trim();
  if (!withoutOurs) {
    return null;
  }

  const capped =
    withoutOurs.length > USER_AGENTS_FILE_MAX_CHARS
      ? withoutOurs.slice(0, USER_AGENTS_FILE_MAX_CHARS) + TRUNCATION_NOTE
      : withoutOurs;

  return [
    "[The user's agents file]",
    `The user keeps a global agents file (${displayPath}) with instructions for AI tools on this device. Follow it the same way other agent tools do. What the user says right now beats what it says. Never edit it without their explicit okay.`,
    "",
    `--- ${displayPath} ---`,
    capped,
    "--- end of file ---",
  ].join("\n");
}

/**
 * The user's global agents file for the current send, or `null` when the
 * file is absent, empty, only contains our own published block, or can't
 * be read. Missing or broken must never break a send.
 */
export async function getAgentsFilePreamble(): Promise<string | null> {
  if (!window.__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const homeDir = await getHomeDir();
    const path = `${homeDir}/.agents/AGENTS.md`;
    if (!(await pathExists(path))) {
      return null;
    }
    const payload = await readTextFile(path);
    return buildAgentsFilePreamble(payload.contents, "~/.agents/AGENTS.md");
  } catch (error) {
    console.warn("[me] couldn't read the user's agents file", error);
    return null;
  }
}
