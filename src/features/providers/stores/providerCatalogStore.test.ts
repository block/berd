import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { useProviderCatalogStore } from "./providerCatalogStore";

function entry(id: string, displayName = id): ProviderCatalogEntry {
  return {
    id,
    displayName,
    category: "model",
    description: id,
    setupMethod: "single_api_key",
    group: "default",
  };
}

describe("providerCatalogStore.mergeEntries", () => {
  beforeEach(() => {
    useProviderCatalogStore.getState().setEntries([entry("databricks_v2")]);
  });

  it("appends new entries while keeping existing ones", () => {
    useProviderCatalogStore.getState().mergeEntries([entry("openai")]);

    expect(
      useProviderCatalogStore.getState().entries.map((item) => item.id),
    ).toEqual(["databricks_v2", "openai"]);
  });

  it("replaces an existing entry that shares an id", () => {
    useProviderCatalogStore
      .getState()
      .mergeEntries([entry("databricks_v2", "Replaced")]);

    const entries = useProviderCatalogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].displayName).toBe("Replaced");
  });
});
