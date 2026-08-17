import { describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaSource,
  getRealPersonaDescription,
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

  it("returns a real, user-authored description as-is", () => {
    expect(
      getRealPersonaDescription(
        persona({ sourceDescription: "Reviews your code and catches bugs." }),
      ),
    ).toBe("Reviews your code and catches bugs.");
  });

  it("treats the legacy 'Agent' placeholder as no description", () => {
    expect(
      getRealPersonaDescription(persona({ sourceDescription: "Agent" })),
    ).toBeUndefined();
    // Case-insensitive and trims whitespace, since the placeholder could
    // come back from the API in either form.
    expect(
      getRealPersonaDescription(persona({ sourceDescription: "  AGENT  " })),
    ).toBeUndefined();
  });

  it("treats the builder-draft 'Draft' placeholder as no description", () => {
    expect(
      getRealPersonaDescription(persona({ sourceDescription: "Draft" })),
    ).toBeUndefined();
  });

  it("treats a missing or empty description as no description", () => {
    expect(
      getRealPersonaDescription(persona({ sourceDescription: undefined })),
    ).toBeUndefined();
    expect(
      getRealPersonaDescription(persona({ sourceDescription: "   " })),
    ).toBeUndefined();
  });
});
