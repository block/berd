import type { Persona } from "@/shared/types/agents";

// Berdy is already featured by the onboarding tour widget. These are the two
// additional agent pins that complete the three-agent starter Home.
export const STARTER_AGENT_NAMES = ["Tinker", "Wildcard"] as const;
const STARTER_AGENT_FILE_NAMES = ["tinker.md", "wildcard.md"] as const;
const LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded";
const SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded-v5";
const STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-agent-pins-eligible-v1";
let starterAgentPinsEligibleForCurrentRun = false;

export function starterAgentIndex(persona: Persona): number {
  const normalizedPath = persona.id.replaceAll("\\", "/").toLowerCase();
  return STARTER_AGENT_FILE_NAMES.findIndex((fileName) => {
    const stem = fileName.slice(0, -3);
    return (
      normalizedPath.endsWith(`/.agents/agents/${fileName}`) ||
      normalizedPath.endsWith(`/.agents/agents/${stem}2.md`)
    );
  });
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
      localStorage.getItem(LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY) === "1" &&
      !haveStarterAgentPinsBeenSeeded()
    );
  } catch {
    return false;
  }
}

export function resetStarterAgentPinsSeeded(): void {
  starterAgentPinsEligibleForCurrentRun = false;
  try {
    localStorage.removeItem(SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v4");
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v3");
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v2");
    localStorage.removeItem(LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterAgentPinsSeeded(): void {
  starterAgentPinsEligibleForCurrentRun = false;
  try {
    localStorage.setItem(SEEDED_STARTER_AGENTS_STORAGE_KEY, "1");
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v4");
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v3");
    localStorage.removeItem("goose:home:starter-agent-pins-seeded-v2");
    localStorage.removeItem(LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY);
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
  for (const persona of personas) {
    if (!isBundledPersona(persona)) continue;
    const index = starterAgentIndex(persona);
    if (index < 0) continue;
    const current = selected[index];
    const canonicalSuffix = `/.agents/agents/${STARTER_AGENT_FILE_NAMES[index]}`;
    const isCanonical = persona.id
      .replaceAll("\\", "/")
      .toLowerCase()
      .endsWith(canonicalSuffix);
    if (!current || isCanonical) selected[index] = persona;
  }
  return selected.filter(
    (persona): persona is Persona => persona !== undefined,
  );
}
