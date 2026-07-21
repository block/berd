import type { RemoteSkill } from "../api/skillMarketplace";

/**
 * Case-insensitive match of a remote skill against a search query, across its
 * name, description, author, and roles. An empty/whitespace query matches all.
 */
export function remoteSkillMatchesQuery(
  skill: RemoteSkill,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [skill.name, skill.description, skill.author ?? "", ...skill.roles]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}
