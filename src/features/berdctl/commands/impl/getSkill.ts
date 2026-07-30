import { z } from "zod/v4";

import { defineCommand } from "../types";

const getSkillSchema = z
  .object({
    skill_id: z.string().describe("Id of the skill to read (from list)."),
  })
  .strict();

interface GetSkillResult {
  skill_id: string;
  name: string;
  description: string;
  source: "app" | "global" | "project" | "builtin";
  instructions: string;
}

export const getSkillCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read one skill including its SKILL.md instructions",
  description:
    "Read one skill including its SKILL.md instructions; does not change " +
    "anything on screen.",
  helpFooter: `Example:
  berdctl skill get --skill-id <skill-id> --json

Result:
  {"skill_id": "...", "name": "...", "description": "...",
   "source": "app"|"builtin"|"global"|"project", "instructions": "..."}`,
  schema: getSkillSchema,
  execute: async (args): Promise<GetSkillResult> => {
    const { findSkillOrThrow } = await import("../runtime/skills");
    const skill = await findSkillOrThrow(args.skill_id);
    return {
      skill_id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.sourceKind,
      instructions: skill.instructions,
    };
  },
});
