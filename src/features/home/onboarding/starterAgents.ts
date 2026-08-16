import type { Persona } from "@/shared/types/agents";

// Berdy is already featured by the onboarding tour widget. These are the two
// additional agent pins that complete the three-agent starter Home.
export const STARTER_AGENT_NAMES = ["Tinker", "Wildcard"] as const;
const STARTER_AGENT_FILE_NAMES = ["tinker.md", "wildcard.md"] as const;
const LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEYS = [
  "goose:home:starter-agent-pins-seeded",
  "goose:home:starter-agent-pins-seeded-v2",
  "goose:home:starter-agent-pins-seeded-v3",
  "goose:home:starter-agent-pins-seeded-v4",
] as const;
const SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded-v5";
const STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-agent-pins-eligible-v1";
let starterAgentPinsEligibleForCurrentRun = false;

function metadataFor(persona: Persona): Record<string, unknown> | undefined {
  const metadata = persona.sourceProperties?.metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function bundledSourceId(persona: Persona): string | undefined {
  const metadata = metadataFor(persona);
  const managedSource = metadata?.berdBundledAllocationSource;
  if (typeof managedSource === "string") return managedSource;
  const source = metadata?.berdBundledSource;
  return typeof source === "string" ? source : undefined;
}

function isManagedBundledCopy(persona: Persona): boolean {
  return metadataFor(persona)?.berdManagedBundledCopy === true;
}

export function starterAgentIndex(persona: Persona): number {
  return STARTER_AGENT_FILE_NAMES.findIndex(
    (fileName) => bundledSourceId(persona) === fileName.slice(0, -3),
  );
}

function isBundledPersona(persona: Persona): boolean {
  const metadata = persona.sourceProperties?.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "berdBundled" in metadata &&
    metadata.berdBundled === true
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
  if (starterAgentPinsEligibleForCurrentRun) return true;
  try {
    return (
      localStorage.getItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function markStarterAgentPinsEligible(): void {
  starterAgentPinsEligibleForCurrentRun = true;
  try {
    localStorage.setItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY, "1");
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function shouldRemoveLegacyBerdyPin(): boolean {
  try {
    return (
      LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEYS.some(
        (key) => localStorage.getItem(key) === "1",
      ) && !haveStarterAgentPinsBeenSeeded()
    );
  } catch {
    return false;
  }
}

export function resetStarterAgentPinsSeeded(): void {
  starterAgentPinsEligibleForCurrentRun = false;
  try {
    localStorage.removeItem(SEEDED_STARTER_AGENTS_STORAGE_KEY);
    for (const key of LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterAgentPinsSeeded(): void {
  starterAgentPinsEligibleForCurrentRun = false;
  try {
    localStorage.setItem(SEEDED_STARTER_AGENTS_STORAGE_KEY, "1");
    for (const key of LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

/** Returns at most one bundled persona per starter slot in Home canvas order. */
export function selectStarterAgentPersonas(
  personas: readonly Persona[],
): Persona[] {
  const selected: Array<Persona | undefined> = STARTER_AGENT_FILE_NAMES.map(
    () => undefined,
  );
  const haveManagedCopies = personas.some(isManagedBundledCopy);
  for (const persona of personas) {
    if (
      haveManagedCopies
        ? !isManagedBundledCopy(persona)
        : !isBundledPersona(persona)
    ) {
      continue;
    }
    const index = starterAgentIndex(persona);
    if (index < 0) continue;
    if (!selected[index]) selected[index] = persona;
  }
  return selected.filter(
    (persona): persona is Persona => persona !== undefined,
  );
}
