import type { Persona } from "@/shared/types/agents";

export const BERDY_AGENT_FILE_NAME = "berdy.md";
const BERDY_GLOBAL_AGENT_PATH_SUFFIXES = [
  `/.agents/agents/${BERDY_AGENT_FILE_NAME}`,
  "/.agents/agents/berdy2.md",
];

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
      BERDY_GLOBAL_AGENT_PATH_SUFFIXES.some((suffix) =>
        normalizedPath.endsWith(suffix),
      ) &&
      isBerdBundled &&
      persona.displayName.trim().toLowerCase() === "berdy" &&
      persona.avatar === "app-avatar:gloopies-14"
    );
  });

  return berdy?.id ?? null;
}
