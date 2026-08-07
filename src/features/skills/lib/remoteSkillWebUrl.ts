const SKILL_ID_TEMPLATE_PLACEHOLDER = "{skillId}";

/**
 * Builds a distribution-provided marketplace URL for a skill. An absent
 * template intentionally returns undefined so callers can omit the web action
 * without affecting discovery, preview, or installation.
 */
export function remoteSkillWebUrl(
  template: string | undefined,
  name: string,
): string | undefined {
  if (!template) {
    return undefined;
  }
  return template.replace(
    SKILL_ID_TEMPLATE_PLACEHOLDER,
    encodeURIComponent(name),
  );
}
