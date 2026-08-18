import type { Persona } from "@/shared/types/agents";

export const BERDY_AGENT_FILE_NAME = "berdy.md";
const BERDY_GLOBAL_AGENT_PATH_SUFFIX = `/.agents/agents/${BERDY_AGENT_FILE_NAME}`;

export function findBerdyPersonaId(
  personas: readonly Persona[],
): string | null {
  const berdy = personas.find((persona) => {
    const normalizedPath = persona.id.replaceAll("\\", "/").toLowerCase();
    const metadata = persona.sourceProperties?.metadata;
    const isBerdBundled =
      typeof metadata === "object" &&
      metadata !== null &&
      "berdBundled" in metadata &&
      metadata.berdBundled === true;
    return (
      normalizedPath.endsWith(BERDY_GLOBAL_AGENT_PATH_SUFFIX) &&
      isBerdBundled &&
      persona.displayName.trim().toLowerCase() === "berdy" &&
      persona.avatar === "app-avatar:gloopies-22"
    );
  });

  return berdy?.id ?? null;
}
