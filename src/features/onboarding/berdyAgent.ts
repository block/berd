import type { Persona } from "@/shared/types/agents";

export const BERDY_AGENT_FILE_NAME = "berdy.md";

export function findBerdyPersonaId(
  personas: readonly Persona[],
): string | null {
  const haveManagedCopies = personas.some((persona) => {
    const metadata = persona.sourceProperties?.metadata;
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      Reflect.get(metadata, "berdManagedBundledCopy") === true
    );
  });
  const berdy = personas.find((persona) => {
    const metadata = persona.sourceProperties?.metadata;
    const isBerdBundled =
      typeof metadata === "object" &&
      metadata !== null &&
      "berdBundled" in metadata &&
      metadata.berdBundled === true;
    if (typeof metadata !== "object" || metadata === null) return false;
    const metadataRecord = metadata as Record<string, unknown>;
    const managed = metadataRecord.berdManagedBundledCopy === true;
    const sourceId = managed
      ? metadataRecord.berdBundledAllocationSource
      : metadataRecord.berdBundledSource;
    return (
      isBerdBundled &&
      (!haveManagedCopies || managed) &&
      sourceId === "berdy" &&
      persona.displayName.trim().toLowerCase() === "berdy" &&
      persona.avatar === "app-avatar:gloopies-22"
    );
  });

  return berdy?.id ?? null;
}
