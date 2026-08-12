import type { Persona } from "@/shared/types/agents";

export const STARTER_AGENT_NAMES = ["block.md", "Builderbot"] as const;
const LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded";
const SEEDED_STARTER_AGENTS_STORAGE_KEY =
  "goose:home:starter-agent-pins-seeded-v2";
const STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-agent-pins-eligible-v1";

const STARTER_AGENT_NAME_ORDER = new Map(
  STARTER_AGENT_NAMES.map((name, index) => [name.toLowerCase(), index]),
);

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
  try {
    localStorage.removeItem(SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterAgentPinsSeeded(): void {
  try {
    localStorage.setItem(SEEDED_STARTER_AGENTS_STORAGE_KEY, "1");
    localStorage.removeItem(LEGACY_SEEDED_STARTER_AGENTS_STORAGE_KEY);
    localStorage.removeItem(STARTER_AGENT_PINS_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

/** Returns the two pinned starter agents in their Home canvas order. */
export function selectStarterAgentPersonas(
  personas: readonly Persona[],
): Persona[] {
  return personas
    .filter(
      (persona) =>
        isBundledPersona(persona) &&
        STARTER_AGENT_NAME_ORDER.has(persona.displayName.trim().toLowerCase()),
    )
    .sort(
      (left, right) =>
        (STARTER_AGENT_NAME_ORDER.get(left.displayName.trim().toLowerCase()) ??
          Number.MAX_SAFE_INTEGER) -
        (STARTER_AGENT_NAME_ORDER.get(right.displayName.trim().toLowerCase()) ??
          Number.MAX_SAFE_INTEGER),
    );
}
