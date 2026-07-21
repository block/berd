const SKILLS_MARKETPLACE_BASE = "https://dev-guides.sqprod.co/skills";

/**
 * Canonical web URL for a skill in the Block skills marketplace. Mirrors where
 * `sq agents skills marketplace` and go/skills point, so "View on web" lands on
 * the same catalog page users already know.
 */
export function remoteSkillWebUrl(name: string): string {
  return `${SKILLS_MARKETPLACE_BASE}/skill?id=${encodeURIComponent(name)}`;
}
