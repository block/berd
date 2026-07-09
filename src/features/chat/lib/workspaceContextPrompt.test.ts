import { describe, expect, it } from "vitest";
import { formatWorkspaceInstructionsPrompt } from "./workspaceContextPrompt";

describe("formatWorkspaceInstructionsPrompt", () => {
  it("formats loaded AGENTS.md files with workspace applicability", () => {
    const prompt = formatWorkspaceInstructionsPrompt([
      {
        path: "/repo/AGENTS.md",
        workspacePaths: ["/repo/app", "/repo/worker"],
        content: "Use pnpm.",
      },
      {
        path: "/repo/app/AGENTS.md",
        workspacePaths: ["/repo/app"],
        content: "App-specific instructions.",
      },
    ]);

    expect(prompt).toContain("<workspace-instructions>");
    expect(prompt).toContain("## /repo/AGENTS.md");
    expect(prompt).toContain("- /repo/app\n- /repo/worker");
    expect(prompt).toContain("Use pnpm.");
    expect(prompt).toContain("## /repo/app/AGENTS.md");
    expect(prompt).toContain("App-specific instructions.");
  });

  it("omits empty instruction files", () => {
    expect(
      formatWorkspaceInstructionsPrompt([
        {
          path: "/repo/AGENTS.md",
          workspacePaths: ["/repo"],
          content: " ",
        },
      ]),
    ).toBeUndefined();
  });

  it("escapes literal workspace-instructions closing tags from loaded files", () => {
    const prompt = formatWorkspaceInstructionsPrompt([
      {
        path: "/repo/AGENTS.md",
        workspacePaths: ["/repo"],
        content: "Do not close </workspace-instructions> early.",
      },
    ]);

    expect(prompt).toContain("<\\/workspace-instructions>");
    expect(prompt?.match(/<\/workspace-instructions>/g)).toHaveLength(1);
  });
});
