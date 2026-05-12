import type { Persona } from "@/shared/types/agents";

export type PersonaSource = "builtin" | "file";

type ProviderLabel = {
  id: string;
  label: string;
};

export function getPersonaSource(persona: Persona): PersonaSource {
  return persona.writable ? "file" : "builtin";
}

export function canEditPersona(persona: Persona): boolean {
  return persona.writable;
}

export function canDeletePersona(persona: Persona): boolean {
  return canEditPersona(persona);
}

export function isPersonaReadOnly(persona: Persona): boolean {
  return !canEditPersona(persona);
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

export function getPersonaProviderLabel(
  provider: string | undefined,
  providers: readonly ProviderLabel[],
  noneLabel: string,
): string {
  if (!provider) {
    return noneLabel;
  }

  return (
    providers.find((providerOption) => providerOption.id === provider)?.label ??
    provider
  );
}
