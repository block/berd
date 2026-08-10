import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
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
  authoritativeProviderIds: readonly string[] = [],
) => ({
  providers: [
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
  ],
  models,
  isModelInventoryAuthoritative: (providerId: string) =>
    authoritativeProviderIds.includes(providerId),
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

  it("rejects an agent harness persisted as a Goose model provider", () => {
    const persona = {
      provider: "goose",
      modelProviderId: "claude-acp",
      model: "sonnet",
    };

    expect(personaExecutionTarget(persona, context())).toBeUndefined();
    expect(personaTargetMigration(persona, context())).toEqual({
      provider: null,
      modelProviderId: null,
      model: null,
    });
  });

  it("never materializes an agent provider as a Goose target without a model", () => {
    const persona = { provider: "goose", modelProviderId: "claude-acp" };

    expect(personaExecutionTarget(persona, context())).toEqual({
      harnessId: "goose",
    });
    expect(personaTargetMigration(persona, context())).toEqual({
      provider: "goose",
      modelProviderId: null,
      model: null,
    });
  });

  it.each([
    {
      name: "Goose canonical provider with a supported model",
      persona: { provider: "goose", modelProviderId: "openai", model: "gpt-5" },
      models: [{ id: "gpt-5", providerId: "openai" }],
      authoritativeProviderIds: ["openai"],
      target: {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-5",
        modelName: "gpt-5",
      },
      migration: null,
    },
    {
      name: "Goose canonical provider with an unsupported model",
      persona: { provider: "goose", modelProviderId: "openai", model: "gpt-5" },
      models: [],
      authoritativeProviderIds: ["openai"],
      target: { harnessId: "goose", modelProviderId: "openai" },
      migration: { provider: "goose", modelProviderId: "openai", model: null },
    },
    {
      name: "external harness with foreign provider and supported model",
      persona: {
        provider: "claude-acp",
        modelProviderId: "openai",
        model: "sonnet",
      },
      models: [{ id: "sonnet", displayName: "Sonnet" }],
      authoritativeProviderIds: ["claude-acp"],
      target: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "sonnet",
        modelName: "Sonnet",
      },
      migration: {
        provider: "claude-acp",
        modelProviderId: "claude-acp",
        model: "sonnet",
      },
    },
    {
      name: "external harness with foreign provider and unsupported model",
      persona: {
        provider: "claude-acp",
        modelProviderId: "openai",
        model: "gpt-5",
      },
      models: [],
      authoritativeProviderIds: ["claude-acp"],
      target: { harnessId: "claude-acp", modelProviderId: "claude-acp" },
      migration: {
        provider: "claude-acp",
        modelProviderId: "claude-acp",
        model: null,
      },
    },
    {
      name: "external harness with unavailable inventory",
      persona: {
        provider: "claude-acp",
        modelProviderId: "openai",
        model: "gpt-5",
      },
      models: [],
      authoritativeProviderIds: [],
      target: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "gpt-5",
        modelName: "gpt-5",
      },
      migration: {
        provider: "claude-acp",
        modelProviderId: "claude-acp",
        model: "gpt-5",
      },
    },
  ])("canonicalizes $name across persisted target, migration, and wire selection", ({
    persona,
    models,
    authoritativeProviderIds,
    target,
    migration,
  }) => {
    const targetContext = context(models, authoritativeProviderIds);

    expect(personaExecutionTarget(persona, targetContext)).toEqual(target);
    expect(personaTargetMigration(persona, targetContext)).toEqual(migration);
    const wireProviderId =
      target.harnessId === "goose" ? target.modelProviderId : target.harnessId;
    expect(
      gooseServeSelectionFromExecutionTarget(
        personaExecutionTarget(persona, targetContext),
      ),
    ).toEqual({
      providerId: wireProviderId,
      modelId: target.modelId,
      modelName: target.modelName,
    });
  });

  it("owns an external harness model provider and repairs legacy display metadata", () => {
    const persona = {
      provider: "claude-acp",
      modelProviderId: "openai",
      model: "sonnet",
    };
    const target = personaExecutionTarget(
      persona,
      context([{ id: "sonnet", displayName: "Sonnet" }]),
    );

    expect(target).toEqual({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "sonnet",
      modelName: "Sonnet",
    });
    expect(gooseServeSelectionFromExecutionTarget(target)).toEqual({
      providerId: "claude-acp",
      modelId: "sonnet",
      modelName: "Sonnet",
    });
    expect(
      personaTargetMigration(
        persona,
        context([{ id: "sonnet", displayName: "Sonnet" }]),
      ),
    ).toEqual({
      provider: "claude-acp",
      modelProviderId: "claude-acp",
      model: "sonnet",
    });
  });

  it("returns no target for an unknown persisted harness", () => {
    const persona = {
      provider: "deleted-harness",
      modelProviderId: "openai",
      model: "gpt-5",
    };

    expect(personaExecutionTarget(persona, context())).toBeUndefined();
    expect(personaTargetMigration(persona, context())).toEqual({
      provider: null,
      modelProviderId: null,
      model: null,
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
