import gooseAvatar1 from "@/features/agents/assets/icons/goose-avatar-1.png";
import gooseAvatar2 from "@/features/agents/assets/icons/goose-avatar-2.png";
import gooseAvatar3 from "@/features/agents/assets/icons/goose-avatar-3.png";
import gooseAvatar4 from "@/features/agents/assets/icons/goose-avatar-4.png";

// Stable, ordered icon set. Index matches `hash % length`.
const AGENT_ICONS: readonly string[] = [
  gooseAvatar1,
  gooseAvatar2,
  gooseAvatar3,
  gooseAvatar4,
];

/**
 * Deterministic DJB2 hash over the persona ID, modulo the icon set length.
 * Same persona ID always resolves to the same icon — gives each persona a
 * stable visual identity without persisting per-persona icon state.
 */
export function resolveAgentIcon(personaId: string): string {
  let hash = 5381;
  for (let i = 0; i < personaId.length; i += 1) {
    // hash * 33 + charCode, kept in 32-bit range via bitwise op
    hash = ((hash << 5) + hash + personaId.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AGENT_ICONS.length;
  return AGENT_ICONS[index];
}

export const __TEST_ONLY__ = {
  AGENT_ICONS,
};
