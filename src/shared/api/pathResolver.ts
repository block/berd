import { invoke } from "@tauri-apps/api/core";

export interface ResolvePathParams {
  parts: string[];
}

export interface ResolvedPath {
  path: string;
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
 * Returns the subset of `paths` that do not exist or are not directories.
 * `~` prefixes are expanded to the user's home directory before checking.
 */
export async function checkDirectoriesExist(
  paths: string[],
): Promise<string[]> {
  const { missing } = await invoke<CheckDirectoriesExistResponse>(
    "check_directories_exist",
    { request: { paths } },
  );
  return missing;
}
