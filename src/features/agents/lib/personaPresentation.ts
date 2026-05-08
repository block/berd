import type { Persona } from "@/shared/types/agents";

export type PersonaSource = "builtin" | "file" | "custom";

export function getPersonaSource(persona: Persona): PersonaSource {
  if (persona.isBuiltin) {
    return "builtin";
  }
  if (persona.isFromDisk) {
    return "file";
  }
  return "custom";
}

export function isPersonaReadOnly(persona: Persona): boolean {
  return getPersonaSource(persona) !== "custom";
}

export function getPersonaInitials(displayName: string): string {
  const initials = displayName
    .trim()
    .split(/\s+/)
    .map((part) => part.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return initials || "?";
}
