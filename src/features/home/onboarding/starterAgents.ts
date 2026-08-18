import type { Persona } from "@/shared/types/agents";

// Berdy is already featured by the onboarding tour widget. These two pins
// complete the three-agent starter Home.
export const STARTER_AGENT_NAMES = ["Tinker", "Wildcard"] as const;
const STARTER_AGENT_FILE_NAMES = ["tinker.md", "wildcard.md"] as const;
const SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded-v2";
const STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-agent-pins-eligible-v1";

function starterAgentIndex(persona: Persona): number {
  const metadata = persona.sourceProperties?.metadata;
  const bundled =
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "berdBundled") === true;
  if (!bundled) return -1;

  const normalizedPath = persona.id.replaceAll("\\", "/").toLowerCase();
  return STARTER_AGENT_FILE_NAMES.findIndex((fileName) =>
    normalizedPath.endsWith(`/.agents/agents/${fileName}`),
  );
}

export function haveStarterAgentPinsBeenSeeded(): boolean {
  try {
    return localStorage.getItem(SEEDED_STARTER_AGENTS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function areStarterAgentPinsEligible(): boolean {
  try {
    return (
      localStorage.getItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function markStarterAgentPinsEligible(): void {
  try {
    localStorage.setItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY, "1");
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function resetStarterAgentPinsSeeded(): void {
  try {
    localStorage.removeItem(SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterAgentPinsSeeded(): void {
  try {
    localStorage.setItem(SEEDED_STARTER_AGENTS_STORAGE_KEY, "1");
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

/** Returns Tinker and Wildcard in their Home canvas order. */
export function selectStarterAgentPersonas(
  personas: readonly Persona[],
): Persona[] {
  const selected: Array<Persona | undefined> = STARTER_AGENT_FILE_NAMES.map(
    () => undefined,
  );
  for (const persona of personas) {
    const index = starterAgentIndex(persona);
    if (index >= 0 && !selected[index]) selected[index] = persona;
  }
  return selected.filter(
    (persona): persona is Persona => persona !== undefined,
  );
}
