import type { Persona } from "@/shared/types/agents";

export const BERDY_AGENT_FILE_NAME = "berdy.md";
export function findBerdyPersonaId(
  personas: readonly Persona[],
): string | null {
  const berdy = personas.find((persona) => {
    const metadata = persona.sourceProperties?.metadata;
    const isManagedBerdy =
      typeof metadata === "object" &&
      metadata !== null &&
      Reflect.get(metadata, "berdManagedBundledCopy") === true &&
      Reflect.get(metadata, "berdBundledAllocationSource") === "berdy";
    return (
      isManagedBerdy &&
      persona.displayName.trim().toLowerCase() === "berdy" &&
      persona.avatar === "app-avatar:gloopies-22"
    );
  });

  return berdy?.id ?? null;
}
