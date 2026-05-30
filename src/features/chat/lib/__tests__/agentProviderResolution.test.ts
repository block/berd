import { describe, expect, it } from "vitest";
import { resolveSelectedAgentId } from "../agentProviderResolution";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

const catalogEntries: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Claude Code",
    setupMethod: "cli_auth",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude"],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    category: "model",
    description: "OpenAI",
    setupMethod: "single_api_key",
    group: "default",
  },
];

describe("resolveSelectedAgentId", () => {
  it("returns goose when no provider is selected", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: undefined,
      }),
    ).toBe("goose");
  });

  it("resolves known agent from catalog", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "claude-acp",
      }),
    ).toBe("claude-acp");
  });

  it("returns goose for model providers with catalog loaded", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "openai",
      }),
    ).toBe("goose");
  });

  it("preserves persisted claude-acp before catalog loads", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries: [],
        catalogLoaded: false,
        selectedProvider: "claude-acp",
      }),
    ).toBe("claude-acp");
  });

  it("preserves unknown provider before catalog loads", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries: [],
        catalogLoaded: false,
        selectedProvider: "some-future-agent",
      }),
    ).toBe("some-future-agent");
  });

  it("preserves model providers before catalog loads", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries: [],
        catalogLoaded: false,
        selectedProvider: "openai",
      }),
    ).toBe("openai");
  });

  it("preserves agent provider before catalog loads", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries: [],
        catalogLoaded: false,
        selectedProvider: "claude-acp",
      }),
    ).toBe("claude-acp");
  });

  it("falls back to goose after catalog validates provider as non-agent", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "openai",
      }),
    ).toBe("goose");
  });

  it("falls back to goose after catalog validates unknown provider", () => {
    expect(
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded: true,
        selectedProvider: "nonexistent-provider",
      }),
    ).toBe("goose");
  });
});
