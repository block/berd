function normalizeSkillId(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\/+$/g, "")
    .toLocaleLowerCase();
}

export function areSkillPinIdsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
  legacyAlias?: string | null,
): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  if (normalizeSkillId(left) === normalizeSkillId(right)) return true;
  if (!legacyAlias?.trim()) return false;

  const alias = normalizeSkillId(legacyAlias);
  return normalizeSkillId(left) === alias || normalizeSkillId(right) === alias;
}
