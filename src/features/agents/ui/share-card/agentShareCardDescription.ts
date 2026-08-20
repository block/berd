import { graphemeCount } from "@/shared/lib/graphemeCount";

const MAX_CARD_DESCRIPTION_CHARACTERS = 110;

function cleanInstructionText(instructions: string): string {
  return instructions
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/[*_`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toLocaleUpperCase()}${value.slice(1)}` : value;
}

function toThirdPerson(value: string): string {
  return capitalize(
    value
      .replace(/^help them\b/iu, "helps people")
      .replace(/^help this person\b/iu, "helps people")
      .replace(/^actually build\b/iu, "builds")
      .replace(/^build\b/iu, "builds")
      .replace(/^make\b/iu, "makes")
      .replace(/^learn\b/iu, "learns")
      .replace(/^expand\b/iu, "expands")
      .replace(/^find\b/iu, "finds")
      .replace(/^turn\b/iu, "turns")
      .replace(/^review\b/iu, "reviews")
      .replace(/^write\b/iu, "writes"),
  );
}

function sentenceWithinLimit(value: string): string | undefined {
  const sentence = value.trim().replace(/[,;:]?\s*$/u, "");
  if (!sentence) return undefined;
  const punctuated = /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
  return graphemeCount(punctuated) <= MAX_CARD_DESCRIPTION_CHARACTERS
    ? punctuated
    : undefined;
}

function descriptiveJob(text: string): string | undefined {
  const job = text.match(/your job is to\s+(.+?)(?:\.\s|$)/iu)?.[1];
  if (!job) return undefined;

  let description = toThirdPerson(job);
  const context = text.slice(0, text.toLowerCase().indexOf("your job is to"));

  // Resolve vague pronouns from the concrete work named immediately before
  // the job, while keeping the resulting card copy short and extractive.
  if (
    /agent that doesn't exist|agent that isn't quite right/iu.test(context) &&
    /\bit\b/iu.test(description)
  ) {
    const kind = /doesn't exist yet|isn't quite right/iu.test(context)
      ? "new and existing agents"
      : "agents";
    description = description
      .replace(/\bit\b/iu, kind)
      .replace(/\bthem\b/giu, "people")
      .replace(/, then keep it growing$/iu, " and keeps improving them");
  } else if (
    /two or more options|options they're stuck between/iu.test(context)
  ) {
    description = description.replace(/\bthem\b/giu, "people");
    if (!/options/iu.test(description)) description += " between options";
  } else if (/a draft, a plan, a decision, or a chat/iu.test(context)) {
    description = description.replace(
      /\bit\b/iu,
      "drafts, plans, decisions, and chats",
    );
  } else if (/write in their own voice/iu.test(context)) {
    description = description
      .replace(/that voice/iu, "the person's voice")
      .replace(/\bit\b/iu, "that voice");
  } else if (/tracker, a small tool, an interactive app/iu.test(context)) {
    description =
      "Builds trackers, tools, apps, agents, and skills, and helps shape the right solution";
  } else if (/not enough ideas|idea that's gone stale/iu.test(context)) {
    description = `${description.replace(/[.!?]$/u, "")} with fresh ideas and unexpected angles`;
  } else {
    description = description.replace(/\bthem\b/giu, "people");
  }

  return sentenceWithinLimit(description);
}

/** Derives concise public card copy from the role paragraph in the instructions. */
export function deriveAgentCardDescription(
  instructions: string,
  displayName: string,
  fallback = `${displayName.trim() || "This agent"} helps with focused work.`,
): string {
  const text = cleanInstructionText(instructions);
  const withoutIdentity = text.replace(
    new RegExp(
      `^You are ${displayName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.\\s*`,
      "iu",
    ),
    "",
  );

  const job = descriptiveJob(withoutIdentity);
  if (job) return job;

  const purpose = withoutIdentity.match(
    /Your purpose is\s+(.+?)(?:\.\s|$)/iu,
  )?.[1];
  const purposeSentence = purpose
    ? sentenceWithinLimit(toThirdPerson(purpose))
    : undefined;
  if (purposeSentence) return purposeSentence;

  return fallback;
}
