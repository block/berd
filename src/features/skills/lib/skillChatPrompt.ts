import type { SkillInfo } from "../api/skills";
import type { ChatSkillDraft } from "@/features/chat/types";
import { getSkillProviderCapabilities } from "@/features/chat/lib/skillProviderCapabilities";

type SkillLike = Pick<SkillInfo, "name">;
type SkillDraftLike = Pick<
  ChatSkillDraft,
  "name" | "description" | "instructions" | "fileLocation"
>;
type SkillCatalogLike = Pick<
  SkillInfo,
  "name" | "description" | "fileLocation" | "sourceLabel" | "projectLinks"
>;
export type SkillCommandMatch<TSkill extends SkillLike = SkillLike> = {
  skill: TSkill;
  promptText: string;
  displayText: string;
};
const SKILL_INSTRUCTION_PREFIX = "Use these skills for this request:";
const MAX_SKILL_CATALOG_DESCRIPTION_LENGTH = 240;

const RESERVED_SLASH_COMMANDS = new Set([
  "clear",
  "compact",
  "doctor",
  "prompt",
  "prompts",
  "skills",
]);

export function isReservedSlashCommand(command: string): boolean {
  return RESERVED_SLASH_COMMANDS.has(command.trim().toLowerCase());
}

export function formatSkillChatPrompt(
  skillName: string,
  taskText = "",
): string {
  const name = skillName.trim();
  const task = taskText.trimStart();
  if (!task) {
    return `Use the ${name} skill`;
  }
  return `Use the ${name} skill to ${task}`;
}

export function formatSkillDraftsChatPrompt(
  skills: SkillDraftLike[],
  taskText = "",
): string {
  if (skills.length === 0) {
    return taskText;
  }

  if (skills.length === 1) {
    return formatSkillChatPrompt(skills[0].name, taskText);
  }

  const skillNames = skills
    .map((skill) => skill.name.trim())
    .filter(Boolean)
    .join(", ");
  const task = taskText.trimStart();
  if (!task) {
    return `Use the ${skillNames} skills`;
  }
  return `Use the ${skillNames} skills to ${task}`;
}

function truncateSkillCatalogDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SKILL_CATALOG_DESCRIPTION_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SKILL_CATALOG_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function escapeAvailableSkillsClosingTag(value: string): string {
  return value.replace(/<\/available-skills>/gi, "<\\/available-skills>");
}

function formatSkillAppliesTo(skill: SkillCatalogLike): string {
  const projectPaths = skill.projectLinks
    .map((project) => project.workingDir.trim())
    .filter(Boolean);
  if (projectPaths.length === 0) {
    return escapeAvailableSkillsClosingTag(skill.sourceLabel);
  }
  return escapeAvailableSkillsClosingTag(projectPaths.join(", "));
}

export function formatAvailableSkillsCatalogPrompt(
  skills: SkillCatalogLike[],
): string | undefined {
  const formattedSkills = skills.flatMap((skill) => {
    const name = escapeAvailableSkillsClosingTag(skill.name.trim());
    const description = escapeAvailableSkillsClosingTag(
      truncateSkillCatalogDescription(skill.description),
    );
    const source = escapeAvailableSkillsClosingTag(skill.fileLocation.trim());
    if (!name || !description || !source) {
      return [];
    }

    return [
      [
        `- ${name}: ${description}`,
        `  Source: ${source}`,
        `  Applies to: ${formatSkillAppliesTo(skill)}`,
      ].join("\n"),
    ];
  });

  if (formattedSkills.length === 0) {
    return undefined;
  }

  return [
    "<available-skills>",
    "The following skills are available for this chat. Use a skill when its description matches the task. To use one, read its SKILL.md from Source unless its full instructions are already loaded for this request.",
    "",
    ...formattedSkills,
    "</available-skills>",
  ].join("\n");
}

function formatProviderSkillContextLine(
  providerId: string | null | undefined,
): string {
  const { activationStyle } = getSkillProviderCapabilities(providerId);
  switch (activationStyle) {
    case "codex":
      return "These are Codex-compatible Agent Skills. Treat the loaded SKILL.md content as the active skill instructions for this request.";
    case "claude":
      return "These are Claude Code-compatible Agent Skills. Treat the loaded SKILL.md content as the active skill instructions for this request.";
    case "gemini":
      return "These are Gemini CLI-compatible Agent Skills. Treat the loaded SKILL.md content as the active skill instructions for this request.";
    case "standard":
      return "These are Agent Skills in the SKILL.md format. Treat the loaded content as the active skill instructions for this request.";
    case "goose":
      return "The selected skill instructions are loaded below. Follow these instructions for this request.";
  }
}

export function formatSkillInstructionPrompt(
  skills: SkillDraftLike[],
  options: { providerId?: string | null } = {},
): string {
  const skillNames = skills
    .map((skill) => skill.name.trim())
    .filter(Boolean)
    .join(", ");
  const selectedSkillContexts = skills
    .map((skill) => {
      const name = skill.name.trim();
      const instructions = skill.instructions?.trim();
      if (!name || !instructions) {
        return null;
      }

      return [
        `# Loaded Skill: ${name}`,
        ...(skill.description?.trim() ? ["", skill.description.trim()] : []),
        ...(skill.fileLocation?.trim()
          ? ["", `Source: ${skill.fileLocation.trim()}`]
          : []),
        "",
        "## Content",
        "",
        instructions,
      ].join("\n");
    })
    .filter((context): context is string => context !== null);

  if (selectedSkillContexts.length === 0) {
    return `${SKILL_INSTRUCTION_PREFIX} ${skillNames}.`;
  }

  return [
    `${SKILL_INSTRUCTION_PREFIX} ${skillNames}.`,
    "",
    formatProviderSkillContextLine(options.providerId),
    "If a skill references additional files, use the Source path to locate its skill directory and read nearby files as needed.",
    "",
    ...selectedSkillContexts,
  ].join("\n");
}

export function parseSkillInstructionPrompt(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SKILL_INSTRUCTION_PREFIX)) {
    return [];
  }

  return trimmed
    .slice(SKILL_INSTRUCTION_PREFIX.length)
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/[.。]+$/, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function toChatSkillDraft(
  skill: Pick<
    SkillInfo,
    | "id"
    | "name"
    | "description"
    | "sourceLabel"
    | "instructions"
    | "fileLocation"
  >,
): ChatSkillDraft {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceLabel: skill.sourceLabel,
    instructions: skill.instructions,
    fileLocation: skill.fileLocation,
  };
}

export function expandSkillSlashCommand(
  text: string,
  skills: SkillLike[],
): string | null {
  const match = resolveSkillSlashCommand(text, skills);
  return match?.promptText ?? null;
}

export function resolveSkillSlashCommand<TSkill extends SkillLike>(
  text: string,
  skills: TSkill[],
): SkillCommandMatch<TSkill> | null {
  const match = text.trimStart().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  const command = match[1].toLowerCase();
  if (isReservedSlashCommand(command)) {
    return null;
  }

  const skill = skills.find(
    (candidate) => candidate.name.toLowerCase() === command,
  );
  if (!skill) {
    return null;
  }

  const displayText = match[2]?.trimStart() ?? "";
  return {
    skill,
    promptText: formatSkillChatPrompt(skill.name, displayText),
    displayText,
  };
}
