function normalizeSkillId(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\/+$/g, "")
    .toLocaleLowerCase();
}

/**
 * A skill can accumulate more than one historical pin id over time (a
 * pre-#974 Personal-skill migration, and separately a rename retiring an
 * old-named copy from more than one legacy location). Accepts a single
 * alias or a list so every historical pin id is compared, not just the
 * most recently recorded one.
 */
export function areSkillPinIdsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
  legacyAliases?: string | readonly string[] | null,
): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  if (normalizeSkillId(left) === normalizeSkillId(right)) return true;

  const aliasList = (
    typeof legacyAliases === "string" ? [legacyAliases] : (legacyAliases ?? [])
  ).filter((value): value is string => Boolean(value?.trim()));

  return aliasList.some((legacyAlias) => {
    const alias = normalizeSkillId(legacyAlias);
    return (
      normalizeSkillId(left) === alias || normalizeSkillId(right) === alias
    );
  });
}
