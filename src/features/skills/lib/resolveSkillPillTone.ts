// Pastel pill tones used to colorize Skills tiles. Order is stable so a
// given skill name always resolves to the same tone across renders.
// Each entry references a `bg-pill-{tone}` token defined in globals.css.
export const SKILL_PILL_TONES = [
  "pink",
  "olive",
  "blue",
  "lavender",
  "sage",
  "mint",
  "peach",
] as const;

export type SkillPillTone = (typeof SKILL_PILL_TONES)[number];

function isSkillPillTone(value: unknown): value is SkillPillTone {
  return (
    typeof value === "string" &&
    (SKILL_PILL_TONES as readonly string[]).includes(value)
  );
}

/**
 * Resolve the pill tone for a skill. A user-chosen `stored` tone wins; if
 * the skill predates the picker (or the value is unknown), fall back to a
 * DJB2 hash of the name so the color stays stable across renders.
 *
 * Empty string is safe: the hash seed (5381) yields tone index 0.
 */
export function resolveSkillPillTone(
  skillName: string,
  stored?: string | null,
): SkillPillTone {
  if (isSkillPillTone(stored)) {
    return stored;
  }
  let hash = 5381;
  for (let i = 0; i < skillName.length; i += 1) {
    // hash * 33 + charCode, kept in 32-bit range via bitwise op
    hash = ((hash << 5) + hash + skillName.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % SKILL_PILL_TONES.length;
  return SKILL_PILL_TONES[index];
}

/**
 * Tailwind class for a given tone. The string is fully written out so
 * Tailwind's content scanner picks it up at build time (no dynamic
 * concatenation of class fragments).
 */
export function skillPillToneClass(tone: SkillPillTone): string {
  switch (tone) {
    case "pink":
      return "bg-pill-pink";
    case "olive":
      return "bg-pill-olive";
    case "blue":
      return "bg-pill-blue";
    case "lavender":
      return "bg-pill-lavender";
    case "sage":
      return "bg-pill-sage";
    case "mint":
      return "bg-pill-mint";
    case "peach":
      return "bg-pill-peach";
  }
}
