import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getHomeDir } from "@/shared/api/system";
import { expandHomePath, isHomeRelativePath } from "@/shared/lib/homePath";

export interface WorkspaceInstructionFile {
  path: string;
  workspacePaths: string[];
  content: string;
}

interface LoadWorkspaceContextResponse {
  instructionFiles: WorkspaceInstructionFile[];
}

export const WORKSPACE_INSTRUCTIONS_QUERY_KEY_PREFIX = [
  "workspace-context",
  "instruction-files",
] as const;

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

// Expand `~` before deduping so `~/foo` and `/Users/me/foo` collapse to one
// backend load instead of the same directory being read once per spelling.
async function normalizeWorkspacePaths(paths: string[]): Promise<string[]> {
  let homeDir: string | null = null;
  if (paths.some(isHomeRelativePath)) {
    homeDir = await getHomeDir().catch(() => null);
  }
  return [
    ...new Set(
      paths.map((path) => (homeDir ? expandHomePath(path, homeDir) : path)),
    ),
  ];
}

export interface LoadWorkspaceInstructionFilesOptions {
  /** When provided, the load is routed through a shared react-query entry so
   *  simultaneous callers share one in-flight request. */
  queryClient?: QueryClient;
}

export async function loadWorkspaceInstructionFiles(
  workspacePaths: string[],
  options: LoadWorkspaceInstructionFilesOptions = {},
): Promise<WorkspaceInstructionFile[]> {
  const trimmedPaths = workspacePaths
    .map((path) => path.trim())
    .filter(Boolean);
  if (trimmedPaths.length === 0 || !isDesktopRuntime()) {
    return [];
  }

  const normalizedPaths = await normalizeWorkspacePaths(trimmedPaths);
  const load = async () => {
    const response = await invoke<LoadWorkspaceContextResponse>(
      "load_workspace_context",
      {
        request: {
          workspacePaths: normalizedPaths,
        },
      },
    );
    return response.instructionFiles;
  };

  const { queryClient } = options;
  if (!queryClient) {
    return load();
  }
  // `staleTime: 0`, not a settled cache: these files are injected into the
  // session system prompt and nothing invalidates the entry when a user edits
  // an AGENTS/CLAUDE-style file on disk, so serving a settled read would feed
  // the agent superseded project guidance. The shared key still collapses a
  // navigation's simultaneous loads onto one in-flight request; only a later
  // call — a fresh navigation or send — refetches instead of reusing stale
  // instructions.
  return queryClient.fetchQuery({
    queryKey: [...WORKSPACE_INSTRUCTIONS_QUERY_KEY_PREFIX, normalizedPaths],
    queryFn: load,
    staleTime: 0,
    retry: false,
  });
}
