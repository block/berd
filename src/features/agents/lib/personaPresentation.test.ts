import { describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaSource,
  isPersonaReadOnly,
} from "./personaPresentation";

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "/tmp/agent.md",
    displayName: "Scout",
    systemPrompt: "Research carefully.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

describe("personaPresentation", () => {
  it("treats only explicitly writable personas as editable", () => {
    expect(canEditPersona(persona({ writable: true }))).toBe(true);
    expect(canEditPersona(persona({ writable: false }))).toBe(false);
    expect(isPersonaReadOnly(persona({ writable: false }))).toBe(true);
  });

  it("allows delete only for writable personas", () => {
    expect(canDeletePersona(persona({ writable: true }))).toBe(true);
    expect(canDeletePersona(persona({ writable: false }))).toBe(false);
  });

  it("derives persona source from writability", () => {
    expect(getPersonaSource(persona({ writable: true }))).toBe("file");
    expect(getPersonaSource(persona({ writable: false }))).toBe("builtin");
  });
});
