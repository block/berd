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

export async function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

export async function saveExportedAgentFile(
  defaultFilename: string,
  contents: string,
): Promise<string | null> {
  return invoke("save_exported_agent_file", { defaultFilename, contents });
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
