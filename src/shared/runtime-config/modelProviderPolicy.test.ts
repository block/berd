import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./schema";
import {
  filterDiscoveredModelIds,
  managedGooseSelectionChanged,
  resolveManagedGooseProviderSelection,
} from "./modelProviderPolicy";

const managedConfig: RuntimeConfig = {
  schemaVersion: 1,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks v2",
        models: [
          { id: "goose-gpt-5-5", name: "GPT-5.5" },
          { id: "shared-model", name: "Shared" },
        ],
      },
      {
        id: "other-managed",
        displayName: "Other managed",
        models: [{ id: "other-model", name: "Other" }],
      },
    ],
  },
};

describe("filterDiscoveredModelIds", () => {
  it("preserves the provider inventory when no prefix policy is configured", () => {
    expect(
      filterDiscoveredModelIds(managedConfig, "other-managed", [
        "first-model",
        "second-model",
      ]),
    ).toEqual(["first-model", "second-model"]);
  });

  it("keeps only model ids matching the provider prefix allowlist", () => {
    const config: RuntimeConfig = {
      ...managedConfig,
      goose: {
        ...managedConfig.goose,
        modelProviders: managedConfig.goose.modelProviders.map((provider) =>
          provider.id === "databricks_v2"
            ? {
                ...provider,
                allowedModelIdPrefixes: ["goose-", "team.approved."],
              }
            : provider,
        ),
      },
    };

    expect(
      filterDiscoveredModelIds(config, "databricks_v2", [
        "goose-gpt-5-5",
        "team.approved.chat-model",
        "other.schema.chat-model",
      ]),
    ).toEqual(["goose-gpt-5-5", "team.approved.chat-model"]);
  });
});

describe("resolveManagedGooseProviderSelection", () => {
  it("returns unrestricted for an empty provider list", () => {
    expect(
      resolveManagedGooseProviderSelection(
        { goose: { modelProviders: [] } },
        { providerId: "openai", modelId: "gpt-5" },
      ),
    ).toBeNull();
  });

  it("leaves an allowed provider and upstream model unchanged", () => {
    const current = { providerId: "other-managed", modelId: "other-model" };
    const resolved = resolveManagedGooseProviderSelection(
      managedConfig,
      current,
    );

    expect(resolved).toEqual(current);
    expect(managedGooseSelectionChanged(current, resolved)).toBe(false);
  });

  it("migrates a disallowed provider and preserves a model declared by the default", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "databricks",
        modelId: "shared-model",
      }),
    ).toEqual({ providerId: "databricks_v2", modelId: "shared-model" });
  });

  it("repairs the legacy Goose model sentinel without live inventory", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "databricks",
        modelId: "goose",
      }),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("preserves a model confirmed by the target Databricks v2 inventory", () => {
    expect(
      resolveManagedGooseProviderSelection(
        managedConfig,
        {
          providerId: "databricks",
          modelId: "new-upstream-model",
        },
        {
          targetModelIds: new Set(["new-upstream-model"]),
          targetInventoryValidated: true,
        },
      ),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "new-upstream-model",
    });
  });

  it("repairs a partially migrated legacy model absent from validated v2 inventory", () => {
    expect(
      resolveManagedGooseProviderSelection(
        managedConfig,
        {
          providerId: "databricks_v2",
          modelId: "goose-claude-4-sonnet",
        },
        {
          targetModelIds: new Set(["goose-gpt-5-5"]),
          targetInventoryValidated: true,
        },
      ),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("repairs any selected v2 model absent from validated live inventory", () => {
    expect(
      resolveManagedGooseProviderSelection(
        managedConfig,
        {
          providerId: "databricks_v2",
          modelId: "any-missing-model",
        },
        {
          targetModelIds: new Set(["goose-gpt-5-5"]),
          targetInventoryValidated: true,
        },
      ),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("preserves an unknown v2 model when inventory cannot be validated", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "databricks_v2",
        modelId: "future-v2-model",
      }),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "future-v2-model",
    });
  });

  it("allows an upstream model missing from an allowed provider inventory", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "other-managed",
        modelId: "new-upstream-model",
      }),
    ).toEqual({
      providerId: "other-managed",
      modelId: "new-upstream-model",
    });
  });

  it("uses the configured default only when no model is selected", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "databricks",
      }),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });
});
