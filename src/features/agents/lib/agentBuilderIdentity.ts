import type { AgentSourceEntry } from "@/shared/api/agents";

export const PLACEHOLDER_AGENT_NAME = "Untitled agent";
export const PLACEHOLDER_AGENT_DESCRIPTION = "Draft";
export const PLACEHOLDER_AGENT_BODY = "Draft in progress.";

export function fileStem(path: string): string {
  const baseName = path.split(/[\\/]/).pop() ?? path;
  const lowerName = baseName.toLowerCase();
  if (lowerName.endsWith(".persona.md")) {
    return baseName.slice(0, -".persona.md".length);
  }
  return lowerName.endsWith(".md") ? baseName.slice(0, -3) : baseName;
}

export function deriveSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return slug || "agent";
}

export function placeholderAgentName(sessionId: string): string {
  const suffix = sessionId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12)
    .replace(/-+$/g, "");

  return suffix
    ? `${PLACEHOLDER_AGENT_NAME} ${suffix}`
    : PLACEHOLDER_AGENT_NAME;
}

export function isPlaceholderAgentName(name: string): boolean {
  return (
    name === PLACEHOLDER_AGENT_NAME ||
    name.startsWith(`${PLACEHOLDER_AGENT_NAME} `)
  );
}

// Re-exported here so callers dealing with agent/draft identity (name,
// description, body placeholders) have one place to import from, alongside
// isPlaceholderAgentName above. The check itself lives in
// @/shared/api/agents, which needs it for create/update/export — this module
// only imports a *type* from there (erased at build time), so re-exporting
// its values here doesn't create a real circular dependency.
export {
  hasRealAgentDescription,
  isPlaceholderAgentDescription,
} from "@/shared/api/agents";

export function isEmptyPlaceholderDraft(source: AgentSourceEntry): boolean {
  const builderSessionId =
    typeof source.properties?.builderSessionId === "string"
      ? source.properties.builderSessionId
      : null;

  return (
    builderSessionId !== null &&
    isPlaceholderDraftForSession(source, builderSessionId)
  );
}

export function isPlaceholderDraftForSession(
  source: AgentSourceEntry,
  builderSessionId: string,
): boolean {
  const properties = source.properties ?? {};
  const extraPropertyKeys = Object.keys(properties).filter(
    (key) =>
      key !== "draft" &&
      key !== "builderSessionId" &&
      key !== "provider" &&
      key !== "model" &&
      key !== "avatar",
  );

  return (
    source.properties?.draft === true &&
    source.properties.builderSessionId === builderSessionId &&
    source.name === placeholderAgentName(builderSessionId) &&
    source.description === PLACEHOLDER_AGENT_DESCRIPTION &&
    source.content === PLACEHOLDER_AGENT_BODY &&
    extraPropertyKeys.length === 0
  );
}
