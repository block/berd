import type { ChatSkillDraft } from "../types";

export const GOOSE_HELP_SKILL_NAME = "goose-help";

export const GOOSE_HELP_SKILL_DRAFT: ChatSkillDraft = {
  id: "builtin:goose-help",
  name: GOOSE_HELP_SKILL_NAME,
  sourceLabel: "Built in",
};

const HELP_INTENT_PATTERNS = [
  /\bhow\s+(?:do|can|would)\s+i\b/,
  /\bwhere\s+(?:do|can|would)\s+i\b/,
  /\bwhat\s+is\s+the\s+(?:way|best\s+way)\s+to\b/,
  /\bcan\s+(?:you\s+)?(?:help|show|walk)\b/,
  /\bcan\s+i\b/,
  /\bis\s+there\s+(?:a\s+)?way\s+to\b/,
  /\b(?:help|show|walk)\s+me\b/,
  /\b(?:troubleshoot|debug|diagnose|fix)\b/,
  /\b(?:broken|stuck|confusing|not\s+working|doesn['’]?t\s+work|won['’]?t|can['’]?t|cannot|failed|failing|error)\b/,
  /\b(?:set\s*up|setup|configure|connect|reconnect|disconnect|change|edit|create|download|export|install|enable|disable)\b/,
];

const APP_CONTEXT_PATTERNS = [
  /\bgoose(?:\s+internal)?\b/,
  /\bthis\s+app\b/,
  /\bthe\s+app\b/,
  /\bapp\s+(?:settings|feature|features|ui|screen|page)\b/,
  /\b(?:agent|persona)\s+(?:builder|creator|editor|avatar|settings|page|profile)\b/,
  /\b(?:custom\s+)?agent\s+avatars?\b/,
  /\bskills?\s+(?:builder|page|view|editor|folder|directory)\b/,
  /\bskill\s+(?:builder|creator|editor)\b/,
  /\bproviders?\s+(?:settings|page|setup|connection|connect)\b/,
  /\bmodels?\s+(?:picker|selector|provider|settings)\b/,
  /\bextensions?\s+(?:settings|page|setup|connection|connect)\b/,
  /\bconnections?\s+(?:settings|page|setup|connect|reconnect)\b/,
  /\bprojects?\s+(?:picker|page|view|settings|working\s+director(?:y|ies))\b/,
  /\b(?:automation|automations)\b/,
  /\bdoctor\b/,
  /\bsettings\s+(?:page|view|screen|section)\b/,
  /\bsession\s+(?:history|archive|export|transcript|thread)\b/,
  /\bchat\s+(?:input|composer|session|history)\b/,
  /\bexport\s+(?:my\s+)?(?:chat|session|conversation|thread)\b/,
  /\bupdates?\s+(?:settings|page|screen)\b/,
  /\bavatars?\s+(?:download|settings|picker|creator|editor)\b/,
];

function normalizeHelpText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function shouldAutoInvokeGooseHelpSkill(text: string): boolean {
  const normalized = normalizeHelpText(text);
  if (!normalized) {
    return false;
  }

  return (
    HELP_INTENT_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    APP_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function resolveGooseHelpSkill(
  text: string,
  availableSkills: ChatSkillDraft[],
): ChatSkillDraft | null {
  if (!shouldAutoInvokeGooseHelpSkill(text)) {
    return null;
  }

  return (
    availableSkills.find(
      (skill) => skill.name.trim().toLowerCase() === GOOSE_HELP_SKILL_NAME,
    ) ?? GOOSE_HELP_SKILL_DRAFT
  );
}
