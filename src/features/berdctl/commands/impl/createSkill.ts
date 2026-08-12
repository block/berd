import { z } from "zod/v4";

import { defineCommand } from "../types";

const createSkillSchema = z
  .object({
    name: z.string().min(1).describe("Name of the new skill."),
    description: z
      .string()
      .min(1)
      .describe(
        "One-line description of what the skill does and when to use it.",
      ),
    content: z.string().min(1).describe("The SKILL.md body content."),
  })
  .strict();

export const createSkillCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Create a new skill (saved as a SKILL.md)",
  description:
    "Create a new skill; it is saved as a SKILL.md and auto-loads into future sessions.",
  helpFooter: `Example:
  berdctl skill create --name "release-notes" \\
    --description "Draft release notes from merged PRs" \\
    --content "$(cat SKILL.md)"

Result:
  {"skill_id": "..."} — the skill is saved as a SKILL.md and auto-loads
  into future sessions.`,
  schema: createSkillSchema,
  execute: async (args) => {
    const [{ createSkill }, { resolveSkillPillTone }] = await Promise.all([
      import("@/features/skills/api/skills"),
      import("@/features/skills/lib/resolveSkillPillTone"),
    ]);
    // Same default the skill editor uses when the user picks no color: the
    // deterministic name-hash tone.
    const skill = await createSkill(
      args.name,
      args.description,
      args.content,
      resolveSkillPillTone(args.name),
    );
    return { skill_id: skill.id };
  },
});
