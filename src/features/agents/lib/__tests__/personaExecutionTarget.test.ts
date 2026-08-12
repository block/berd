import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  personaExecutionTarget,
  personaTargetMigration,
} from "../personaExecutionTarget";

const catalog = (id: string, category: "agent" | "model", aliases?: string[]) =>
  ({
    id,
    displayName: id,
    category,
    aliases,
    description: id,
    setupMethod: "single_api_key",
    group: "default",
  }) as ProviderCatalogEntry;

const context = (
  models: Array<{ id: string; providerId?: string; displayName?: string }> = [],
) => ({
  providers: [
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
  ],
  models,
  catalogEntries: [
    catalog("goose", "agent"),
    catalog("claude-acp", "agent", ["claude"]),
    catalog("openai", "model"),
    catalog("anthropic", "model"),
    catalog("databricks_v2", "model", ["databricks"]),
  ],
});

describe("personaExecutionTarget", () => {
  it("returns no override when the agent has no configured target", () => {
    expect(personaExecutionTarget({}, context())).toBeUndefined();
  });

  it("returns the complete saved Goose target without requiring inventory", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", modelProviderId: "openai", model: "gpt-5" },
        context(),
      ),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-5",
      modelName: "gpt-5",
    });
  });

  it("uses an external harness as the runtime provider boundary", () => {
    expect(
      personaExecutionTarget(
        { provider: "claude-acp", model: "sonnet" },
        context([{ id: "sonnet", displayName: "Sonnet" }]),
      ),
    ).toEqual({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "sonnet",
      modelName: "Sonnet",
    });
  });

  it("temporarily resolves an incomplete legacy target from one inventory match", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", model: "shared" },
        context([{ id: "shared", providerId: "openai" }]),
      ),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "shared",
      modelName: "shared",
    });
  });

  it("returns no override for a genuinely ambiguous legacy target", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", model: "shared" },
        context([
          { id: "shared", providerId: "openai" },
          { id: "shared", providerId: "anthropic" },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("personaTargetMigration", () => {
  it("persists the known internal Databricks v1 to v2 repair", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "goose-claude-fable-5" },
        context([
          {
            id: "goose-claude-fable-5",
            providerId: "databricks",
          },
          {
            id: "goose-claude-fable-5",
            providerId: "databricks_v2",
          },
        ]),
      ),
    ).toEqual({
      provider: "goose",
      modelProviderId: "databricks_v2",
      model: "goose-claude-fable-5",
    });
  });

  it("canonicalizes a legacy provider stored in the harness field", () => {
    expect(
      personaTargetMigration(
        { provider: "databricks", model: "goose-gpt-5-5" },
        context(),
      ),
    ).toEqual({
      provider: "goose",
      modelProviderId: "databricks_v2",
      model: "goose-gpt-5-5",
    });
  });

  it("clears an ambiguous target that cannot be repaired deterministically", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "shared" },
        context([
          { id: "shared", providerId: "openai" },
          { id: "shared", providerId: "anthropic" },
        ]),
      ),
    ).toEqual({ provider: null, modelProviderId: null, model: null });
  });

  it("preserves an unmatched legacy target when inventory may be incomplete", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "temporarily-unavailable" },
        context(),
      ),
    ).toBeNull();
  });

  it("preserves a complete target even when its provider is disconnected", () => {
    expect(
      personaTargetMigration(
        {
          provider: "goose",
          modelProviderId: "openai",
          model: "future-model",
        },
        context(),
      ),
    ).toBeNull();
  });
});
