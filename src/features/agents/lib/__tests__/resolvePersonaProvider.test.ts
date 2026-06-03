import { describe, expect, it } from "vitest";
import type { AcpProvider } from "@/shared/api/acp";
import type { Persona } from "@/shared/types/agents";
import { resolvePersonaProvider } from "../resolvePersonaProvider";

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

const PROVIDERS: AcpProvider[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
];

describe("resolvePersonaProvider", () => {
  it("returns undefined when the persona has no provider", () => {
    expect(resolvePersonaProvider(persona(), PROVIDERS)).toBeUndefined();
    expect(resolvePersonaProvider(null, PROVIDERS)).toBeUndefined();
    expect(resolvePersonaProvider(undefined, PROVIDERS)).toBeUndefined();
  });

  it("matches on exact provider id", () => {
    expect(
      resolvePersonaProvider(persona({ provider: "openai" }), PROVIDERS),
    ).toEqual({ id: "openai", label: "OpenAI" });
  });

  it("falls back to a case-insensitive label substring match", () => {
    expect(
      resolvePersonaProvider(persona({ provider: "anthropic" }), PROVIDERS),
    ).toEqual({ id: "anthropic", label: "Anthropic" });
    expect(
      resolvePersonaProvider(persona({ provider: "OPENAI" }), PROVIDERS),
    ).toEqual({ id: "openai", label: "OpenAI" });
  });

  it("resolves Goose as an implicit provider", () => {
    expect(resolvePersonaProvider(persona({ provider: "Goose" }), [])).toEqual({
      id: "goose",
      label: "Goose",
    });
    expect(
      resolvePersonaProvider(persona({ provider: "GOOSE" }), PROVIDERS),
    ).toEqual({ id: "goose", label: "Goose" });
  });

  it("returns undefined when nothing matches", () => {
    expect(
      resolvePersonaProvider(persona({ provider: "gemini" }), PROVIDERS),
    ).toBeUndefined();
  });

  it("returns undefined when providers are still empty", () => {
    expect(
      resolvePersonaProvider(persona({ provider: "openai" }), []),
    ).toBeUndefined();
  });
});
