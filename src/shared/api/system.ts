import { invoke } from "@tauri-apps/api/core";

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface AttachmentPathInfo {
  name: string;
  path: string;
  kind: "file" | "directory";
  mimeType?: string | null;
}

export interface FileMentionMatchHighlight {
  /** Which rendered string the indices apply to. */
  target: "filename" | "path";
  /** Char indices (not UTF-16 code units) of matched characters. */
  indices: number[];
}

export interface FileMentionPathEntry {
  resolvedPath: string;
  displayPath: string;
  filename: string;
  kind: "file" | "folder" | "path";
  source: "project" | "session" | "home" | "filesystem";
  /** Match tier assigned by the native matcher (lower is better). */
  matchRank?: number;
  matchHighlight?: FileMentionMatchHighlight;
}

export interface ImageAttachmentPayload {
  base64: string;
  mimeType: string;
}

// The home directory never changes for the lifetime of the app, so resolve it
// once and share the promise across every caller (mention handlers, workspace
// path normalization, git-state keys) instead of re-invoking per mount.
let homeDirRequest: Promise<string> | null = null;
let cachedHomeDir: string | null = null;
const homeDirListeners = new Set<() => void>();

export function getHomeDir(): Promise<string> {
  if (!homeDirRequest) {
    const request = Promise.resolve()
      .then(() => invoke<string>("get_home_dir"))
      .then((dir) => {
        cachedHomeDir = dir;
        for (const listener of [...homeDirListeners]) {
          listener();
        }
        return dir;
      });
    homeDirRequest = request;
    request.catch(() => {
      if (homeDirRequest === request) {
        homeDirRequest = null;
      }
    });
  }
  return homeDirRequest;
}

/** Synchronous read of the already-resolved home directory, or null before
 *  the first successful `getHomeDir()` call settles. */
export function getCachedHomeDir(): string | null {
  return cachedHomeDir;
}

/** Notified once when the home dir resolves. A failed lookup clears the shared
 *  request slot, so any later `getHomeDir()` call retries; subscribers mounted
 *  before that retry still observe its success through this store instead of
 *  staying pinned to the null they read at mount. */
export function subscribeHomeDir(listener: () => void): () => void {
  homeDirListeners.add(listener);
  return () => {
    homeDirListeners.delete(listener);
  };
}

export async function saveExportedAgentFile(
  defaultFilename: string,
  contents: string,
): Promise<string | null> {
  return invoke("save_exported_agent_file", { defaultFilename, contents });
}

export async function saveExportedAgentImage(
  defaultFilename: string,
  contents: Uint8Array,
): Promise<string | null> {
  return invoke("save_exported_agent_image", {
    defaultFilename,
    contents: Array.from(contents),
  });
}

export async function saveExportedSessionFile(
  defaultFilename: string,
  contents: string,
): Promise<string | null> {
  return invoke("save_exported_session_file", { defaultFilename, contents });
}

export interface SessionExportItem {
  filename: string;
  contents: string;
}

export interface SessionExportBatchResult {
  folder: string;
  files: string[];
}

export async function saveExportedSessionFiles(
  items: SessionExportItem[],
): Promise<SessionExportBatchResult | null> {
  return invoke("save_exported_session_files", { items });
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

export async function ensureDirectory(path: string): Promise<void> {
  return invoke("ensure_directory", { path });
}

export async function searchFilesForMentions(input: {
  roots: string[];
  query: string;
  maxResults?: number;
}): Promise<FileMentionPathEntry[]> {
  return invoke("search_file_mentions", {
    roots: input.roots,
    query: input.query,
    maxResults: input.maxResults,
  });
}

export async function listDirectoryEntries(
  path: string,
): Promise<FileTreeEntry[]> {
  return invoke("list_directory_entries", { path });
}

export async function inspectAttachmentPaths(
  paths: string[],
): Promise<AttachmentPathInfo[]> {
  return invoke("inspect_attachment_paths", { paths });
}

export async function readImageAttachment(
  path: string,
): Promise<ImageAttachmentPayload> {
  return invoke("read_image_attachment", { path });
}

export interface TextFilePayload {
  contents: string;
  byteSize: number;
  truncated: boolean;
  mimeType?: string | null;
}

export async function readTextFile(path: string): Promise<TextFilePayload> {
  return invoke("read_text_file", { path });
}

/**
 * Create a text file (and any missing parent directories) only if it does
 * not already exist. Fails rather than overwriting existing content.
 */
export async function createTextFile(
  path: string,
  contents: string,
): Promise<void> {
  return invoke("create_text_file", { path, contents });
}

/**
 * Overwrite a UTF-8 text file, creating parent directories as needed. For
 * user-initiated edits of user-owned files (e.g. the Settings → Me editor)
 * — agent writes must not route through this.
 */
export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

/** One recorded change in a me.md timeline. */
export interface MeHistoryEntry {
  timestampMs: number;
  author: string;
  message: string;
}

/**
 * Record the current state of the user's me.md in its invisible local
 * history, attributed to a source ("created" | "user" | "delete" | "external" |
 * "agent:<name>" | "agent-edit:<name>"). Pass `summary` — the affected entry —
 * when the caller knows it, so the record says what changed and not only who
 * changed it. Best-effort by design: callers must treat failures as
 * non-fatal — history must never break a write.
 */
export async function recordMeHistory(
  filePath: string,
  source: string,
  summary?: string,
): Promise<boolean> {
  return invoke("record_me_history", { filePath, source, summary });
}

/** The recorded timeline for the user's me.md, newest first. */
export async function listMeHistory(
  filePath: string,
): Promise<MeHistoryEntry[]> {
  return invoke("list_me_history", { filePath });
}

/**
 * (De)register the memory MCP server for future goose sessions. Off means
 * the memory tools don't exist in sessions at all — the cleanest off state.
 */
export async function setMemoryMcpEnabled(enabled: boolean): Promise<void> {
  return invoke("set_memory_mcp_enabled", { enabled });
}
