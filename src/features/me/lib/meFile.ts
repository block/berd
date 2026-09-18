import {
  getHomeDir,
  initializeMemoryStore,
  listMemoryDocuments,
  readMemoryTextFile,
} from "@/shared/api/system";
import { normalizeMemoryPath } from "./memoryPaths";
import { saveMemoryDocument } from "./saveMemoryDocument";

/** Logical paths in the encrypted, user-owned memory store. */
export const ME_FILE_SEGMENTS = [".me", "me.md"] as const;

function joinHome(homeDir: string, segments: readonly string[]): string {
  const trimmed = normalizeMemoryPath(homeDir);
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
  const trimmed = normalizeMemoryPath(homeDir);
  const canonical = normalizeMemoryPath(path);
  return canonical.startsWith(`${trimmed}/`)
    ? `~${canonical.slice(trimmed.length)}`
    : canonical;
}

/**
 * Starter content seeded on first creation. This is user-owned file content,
 * not UI copy — it is intentionally not localized, and the user can rewrite
 * or delete any of it.
 *
 * Structure follows a hub-and-spokes shape: this file is the small,
 * cross-cutting spine Berd can inject when memory is explicitly enabled,
 * while deeper domain knowledge lives in topic files beside it (style.md,
 * family.md), read only when that part of life is relevant. Topics are
 * named by the user, not enumerated by us — agents should preserve any
 * topics the user adds. See meTopics.ts.
 */
export const ME_FILE_TEMPLATE = `# Me

*This file is yours. When memory is on, Berd can read it to learn how to work
with you. Italic notes like this one are just for you — agents never see them.*

*Don't add passwords, credentials, or other access information here. This is
stored in encrypted local files, not a secrets vault. Markdown exports are
plaintext. Encryption does not guarantee protection from other processes running as you.
Berd does not automatically copy
approved memory into other tools.*

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
  const payload = (await listMemoryDocuments()).find(
    (doc) => doc.path === canonical,
  );
  if (payload) {
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
  await initializeMemoryStore();
  const existing = await loadMeFile();
  if (existing.status === "present") {
    return existing;
  }
  await saveMemoryDocument({
    path: existing.path,
    contents: ME_FILE_TEMPLATE,
    topic: null,
    create: true,
  });
  const payload = await readMemoryTextFile(existing.path);
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
  create = false,
): Promise<void> {
  await saveMemoryDocument({ path, contents, topic: null, create });
}
