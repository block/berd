import { z } from "zod/v4";

import { defineCommand } from "../types";

const listSkillsSchema = z
  .object({
    project_id: z
      .string()
      .optional()
      .describe("Also include skills from this project's working directories."),
  })
  .strict();

interface ListSkillsResult {
  skills: Array<{
    skill_id: string;
    name: string;
    description: string;
    source: "app" | "global" | "project" | "builtin";
  }>;
}

export const listSkillsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's skills (name and description only)",
  description:
    "List the user's skills (name and description only); does not change " +
    'anything on screen. Read a skill\'s content with action "get".',
  helpFooter: `Example:
  berdctl skill list --json

Result:
  {"skills": [{"skill_id": "...", "name": "...",
               "description": "...",
               "source": "app"|"builtin"|"global"|"project"}, ...]}
  Read a skill's full content with \`berdctl skill get\`.`,
  schema: listSkillsSchema,
  execute: async (args): Promise<ListSkillsResult> => {
    const { fetchSkills } = await import("../runtime/skills");
    const skills = await fetchSkills(args.project_id);
    return {
      skills: skills.map((skill) => ({
        skill_id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.sourceKind,
      })),
    };
  },
});
