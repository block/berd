import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceInstructionFile {
  path: string;
  workspacePaths: string[];
  content: string;
}

interface LoadWorkspaceContextResponse {
  instructionFiles: WorkspaceInstructionFile[];
}

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function loadWorkspaceInstructionFiles(
  workspacePaths: string[],
): Promise<WorkspaceInstructionFile[]> {
  const normalizedPaths = [
    ...new Set(workspacePaths.map((path) => path.trim())),
  ].filter(Boolean);
  if (normalizedPaths.length === 0 || !isDesktopRuntime()) {
    return [];
  }

  const response = await invoke<LoadWorkspaceContextResponse>(
    "load_workspace_context",
    {
      request: {
        workspacePaths: normalizedPaths,
      },
    },
  );
  return response.instructionFiles;
}
