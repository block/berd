import type { WorkspaceInstructionFile } from "../api/workspaceContext";

function escapeWorkspaceInstructionsClosingTag(value: string): string {
  return value.replace(
    /<\/workspace-instructions>/gi,
    "<\\/workspace-instructions>",
  );
}

function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? escapeWorkspaceInstructionsClosingTag(trimmed) : null;
}

function formatAppliesTo(paths: string[]): string {
  return paths
    .map((path) => `- ${escapeWorkspaceInstructionsClosingTag(path)}`)
    .join("\n");
}

export function formatWorkspaceInstructionsPrompt(
  instructionFiles: WorkspaceInstructionFile[],
): string | undefined {
  const formattedFiles = instructionFiles.flatMap((file) => {
    const content = trimValue(file.content);
    if (!content) {
      return [];
    }

    return [
      [
        `## ${escapeWorkspaceInstructionsClosingTag(file.path)}`,
        "",
        "Applies to:",
        formatAppliesTo(file.workspacePaths),
        "",
        content,
      ].join("\n"),
    ];
  });

  if (formattedFiles.length === 0) {
    return undefined;
  }

  return [
    "<workspace-instructions>",
    "The following AGENTS.md files apply to the included workspaces. Treat them as project-level instructions for the listed workspace paths.",
    "",
    ...formattedFiles,
    "</workspace-instructions>",
  ].join("\n");
}
