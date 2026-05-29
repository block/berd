import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  formatPersonaSystemPrompt,
  getProjectArtifactRoots,
  getProjectFolderName,
  getProjectFolderOption,
} from "./chatProjectContext";

describe("chatProjectContext", () => {
  it("formats persona context as active system-level persona instructions", () => {
    expect(
      formatPersonaSystemPrompt({
        id: "/Users/test/.agents/agents/starfriend.agent.md",
        displayName: "starfriend",
        systemPrompt: "Just a regular guy.",
      }),
    ).toBe(`<active-persona>
Your current name and identity in this conversation is "starfriend". If the user asks who you are, answer as "starfriend", not as Goose.

Use the persona instructions below as active system-level guidance for your behavior, tone, and defaults. Do not treat the persona name as a user command, mention, delegation request, or subagent invocation.

Persona id: /Users/test/.agents/agents/starfriend.agent.md
Persona instructions:
Just a regular guy.
</active-persona>`);
  });

  it("combines persona and project prompts without empty sections", () => {
    expect(
      composeSystemPrompt("Persona prompt", undefined, "Project prompt"),
    ).toBe("Persona prompt\n\nProject prompt");
  });

  it("extracts the folder name from a path", () => {
    expect(getProjectFolderName("/Users/wesb/dev/goose2")).toBe("goose2");
    expect(getProjectFolderName("C:\\Users\\wesb\\goose2\\")).toBe("goose2");
  });

  it("creates folder options from the project's working directories", () => {
    expect(
      getProjectFolderOption({
        workingDirs: ["/Users/wesb/dev/goose2", "/Users/wesb/dev/other"],
      }),
    ).toEqual([
      {
        id: "/Users/wesb/dev/goose2",
        name: "goose2",
        path: "/Users/wesb/dev/goose2",
      },
      {
        id: "/Users/wesb/dev/other",
        name: "other",
        path: "/Users/wesb/dev/other",
      },
    ]);
  });

  it("returns an empty array when workingDirs is empty", () => {
    expect(
      getProjectFolderOption({
        workingDirs: [],
      }),
    ).toEqual([]);
  });

  it("returns an empty array when project is null", () => {
    expect(getProjectFolderOption(null)).toEqual([]);
  });

  it("returns working dirs unchanged", () => {
    expect(
      getProjectArtifactRoots({
        workingDirs: ["/Users/wesb/dev/goose2", "/Users/wesb/dev/other"],
      }),
    ).toEqual(["/Users/wesb/dev/goose2", "/Users/wesb/dev/other"]);
  });
});
