import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./schema";
import {
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

  it("preserves an upstream model while migrating a disallowed provider", () => {
    expect(
      resolveManagedGooseProviderSelection(managedConfig, {
        providerId: "databricks",
        modelId: "new-upstream-model",
      }),
    ).toEqual({
      providerId: "databricks_v2",
      modelId: "new-upstream-model",
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
