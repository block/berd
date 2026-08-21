import {
  createTextFile,
  getHomeDir,
  pathExists,
  readTextFile,
  recordMeHistory,
  writeTextFile,
} from "@/shared/api/system";

/**
 * Best-effort history recording. History must never break a read or write:
 * the file is sacred, the timeline is a bonus. See me_history.rs.
 */
async function tryRecordHistory(path: string, source: string): Promise<void> {
  try {
    await recordMeHistory(path, source);
  } catch (error) {
    console.warn("[me] couldn't record me.md history", error);
  }
}

/**
 * Best-effort publication into the agent files other tools read (see
 * mePublish.ts). Same rule as history: the me.md write is the contract,
 * publication never surfaces as a save failure.
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

/**
 * Legacy location from the first iteration of this exploration. Read if the
 * canonical file doesn't exist; never written to for new files.
 */
export const LEGACY_ME_FILE_SEGMENTS = [".berd", "me", "me.md"] as const;

function joinHome(homeDir: string, segments: readonly string[]): string {
  const trimmed = homeDir.replace(/\/+$/, "");
  return [trimmed, ...segments].join("/");
}

export function meFilePath(homeDir: string): string {
  return joinHome(homeDir, ME_FILE_SEGMENTS);
}

export function legacyMeFilePath(homeDir: string): string {
  return joinHome(homeDir, LEGACY_ME_FILE_SEGMENTS);
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

*This file is yours. Agents read it to learn how to work with you, and
nothing is added without your say-so. Italic notes like this one are just
for you — agents never see them.*

*Don't add passwords or credentials here. This file is read by every agent.*

## About me

*A quick introduction, in a sentence or two — your name, your pronouns,
where you live, what you do with your days, who and what matters to you.
Whatever helps an agent get who it's talking to.*

## How to work with me

*How you like information delivered — brief or thorough, bullets or prose,
lead with the answer or walk through the reasoning.*

## Preferences

*Defaults you want agents to respect — tools you use, formats you like,
things you always want done a certain way.*

## Boundaries

*Things agents should always ask about first, or never do at all.*

## Standing rules

*Rules for every agent, every time — like "draft anything sent on my behalf
and show me first," or "prefix messages sent for me with 🤖."*

## Topics

*Deeper knowledge lives in its own topic files in the "topics" folder
here, like "home.md" or "social.md." Agents only read a topic when it's
relevant to what they're working on. Add one manually, or just tell your
agent.*
`;

export type MeFileState =
  | { status: "missing"; path: string; displayPath: string }
  | {
      status: "present";
      path: string;
      /** ~-relative form of `path` for UI display. */
      displayPath: string;
      contents: string;
      /** True when the file was found at the legacy ~/.berd location. */
      legacy: boolean;
    };

/**
 * Load the user's me.md. Discovery order: the canonical neutral location
 * first, then the legacy Berd-scoped location. New files are only ever
 * created at the canonical path.
 */
export async function loadMeFile(): Promise<MeFileState> {
  const homeDir = await getHomeDir();
  const canonical = meFilePath(homeDir);
  if (await pathExists(canonical)) {
    const payload = await readTextFile(canonical);
    // Sweep up any changes made outside Berd (text editors, other tools)
    // into the timeline, and re-publish so hand-edits reach the agent
    // files too. Cheap when nothing changed; attribution at this boundary
    // is best-effort by design.
    void tryRecordHistory(canonical, "external");
    void tryPublish(payload.contents);
    return {
      status: "present",
      path: canonical,
      displayPath: toDisplayPath(canonical, homeDir),
      contents: payload.contents,
      legacy: false,
    };
  }
  const legacy = legacyMeFilePath(homeDir);
  if (await pathExists(legacy)) {
    const payload = await readTextFile(legacy);
    return {
      status: "present",
      path: legacy,
      displayPath: toDisplayPath(legacy, homeDir),
      contents: payload.contents,
      legacy: true,
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
  await tryRecordHistory(existing.path, "created");
  void tryPublish(ME_FILE_TEMPLATE);
  const payload = await readTextFile(existing.path);
  return {
    status: "present",
    path: existing.path,
    displayPath: existing.displayPath,
    contents: payload.contents,
    legacy: false,
  };
}

/**
 * Save the user's own edit of their me.md (the Settings → Me editor), then
 * record it in the timeline attributed to them. The write is the contract;
 * history is best-effort.
 */
export async function saveMeFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeTextFile(path, contents);
  await tryRecordHistory(path, "user");
  void tryPublish(contents);
}
