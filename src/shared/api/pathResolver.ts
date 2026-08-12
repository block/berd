import { invoke } from "@tauri-apps/api/core";

export interface ResolvePathParams {
  parts: string[];
}

export interface ResolvedPath {
  path: string;
}

export interface CanonicalizeAuthorizedWorkspaceDirectoryParams {
  path: string;
  allowedRoots: string[];
}

export async function resolvePath({
  parts,
}: ResolvePathParams): Promise<ResolvedPath> {
  return invoke("resolve_path", {
    request: { parts },
  });
}

interface CheckDirectoriesExistResponse {
  missing: string[];
}

/**
 * Canonicalizes an existing directory and requires it to be equal to or inside
 * one of the canonicalized workspace roots already authorized for the chat.
 */
export async function canonicalizeAuthorizedWorkspaceDirectory({
  path,
  allowedRoots,
}: CanonicalizeAuthorizedWorkspaceDirectoryParams): Promise<ResolvedPath> {
  return invoke("canonicalize_authorized_workspace_directory", {
    request: { path, allowedRoots },
  });
}

export async function checkDirectoriesExist(
  paths: string[],
): Promise<string[]> {
  const { missing } = await invoke<CheckDirectoriesExistResponse>(
    "check_directories_exist",
    { request: { paths } },
  );
  return missing;
}
