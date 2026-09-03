import {
  createTextFile,
  getHomeDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@/shared/api/system";

/**
 * Best-effort publication into the agent files other tools read (see
 * mePublish.ts). The me.md write is the contract; publication never surfaces
 * as a save failure.
 */
async function tryPublish(contents: string): Promise<void> {
  const { publishMeFile } = await import("./mePublish");
  await publishMeFile(contents);
}

/**
 * Canonical home for the user's me.md, relative to the home directory.
 *
 * This is deliberately a neutral location (`~/.me/`), not Berd's dotfolder:
 * the file is the user's, and other tools they trust should be able to find
 * it without asking Berd. Berd is one reader among (eventually) many. The
 * location and structure follow the me.md protocol exploration — see the
 * compat proposal for the shared-spine + contexts contract.
 */
export const ME_FILE_SEGMENTS = [".me", "me.md"] as const;

function joinHome(homeDir: string, segments: readonly string[]): string {
  const trimmed = homeDir.replace(/\/+$/, "");
  return [trimmed, ...segments].join("/");
}

export function meFilePath(homeDir: string): string {
  return joinHome(homeDir, ME_FILE_SEGMENTS);
}

/** Shortened display form of the canonical me.md path (~/.me/me.md). */
export function meFileDisplayPath(): string {
  return `~/${ME_FILE_SEGMENTS.join("/")}`;
}

/** Shorten an absolute path to ~-relative form for display. */
export function toDisplayPath(path: string, homeDir: string): string {
  const trimmed = homeDir.replace(/\/+$/, "");
  return path.startsWith(`${trimmed}/`)
    ? `~${path.slice(trimmed.length)}`
    : path;
}

/**
 * Starter content seeded on first creation. This is user-owned file content,
 * not UI copy — it is intentionally not localized, and the user can rewrite
 * or delete any of it.
 *
 * Structure follows the memory-v2 hub-and-spokes shape: this file is the
 * spine — small, cross-cutting, read by every agent in every session —
 * while deeper domain knowledge lives in topic files beside it (style.md,
 * family.md), read only when that part of life is relevant. Topics are
 * named by the user, not enumerated by us — agents should preserve any
 * topics the user adds. See meTopics.ts.
 */
export const ME_FILE_TEMPLATE = `# Me

*This file is yours. Agents read it to learn how to work with you. Italic
notes like this one are just for you — agents never see them.*

*Don't add passwords, credentials, or other access information here. When
memory is on, approved content can be made available to agents and compatible
agent tools.*

## About me

*Details you want agents to know about you in every chat.*

## Preferences

*How you want agents to work with you. Response style, behaviors, and
standing rules.*

## Boundaries

*Things agents should always ask about first, or never do at all.*

## Topics

*Additional memories can be specified in their own files in the /topics
folder. Agents only read a topic when it's relevant.*
`;

export type MeFileState =
  | { status: "missing"; path: string; displayPath: string }
  | {
      status: "present";
      path: string;
      /** ~-relative form of `path` for UI display. */
      displayPath: string;
      contents: string;
    };

/** Load the user's canonical me.md file. */
export async function loadMeFile(): Promise<MeFileState> {
  const homeDir = await getHomeDir();
  const canonical = meFilePath(homeDir);
  if (await pathExists(canonical)) {
    const payload = await readTextFile(canonical);
    return {
      status: "present",
      path: canonical,
      displayPath: toDisplayPath(canonical, homeDir),
      contents: payload.contents,
    };
  }
  return {
    status: "missing",
    path: canonical,
    displayPath: toDisplayPath(canonical, homeDir),
  };
}

/** Seed the starter me.md if none exists yet, then return its state. */
export async function createMeFile(): Promise<MeFileState> {
  const existing = await loadMeFile();
  if (existing.status === "present") {
    return existing;
  }
  await createTextFile(existing.path, ME_FILE_TEMPLATE);
  void tryPublish(ME_FILE_TEMPLATE);
  const payload = await readTextFile(existing.path);
  return {
    status: "present",
    path: existing.path,
    displayPath: existing.displayPath,
    contents: payload.contents,
  };
}

/** Save the user's own edit from Settings → Memory. */
export async function saveMeFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeTextFile(path, contents);
  void tryPublish(contents);
}
