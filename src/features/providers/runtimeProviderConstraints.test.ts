import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { filterModelProvidersForRuntimeConfig } from "./runtimeProviderConstraints";

describe("filterModelProvidersForRuntimeConfig", () => {
  const providers = [
    {
      id: "databricks_v2",
      displayName: "Databricks",
      category: "model",
      description: "Databricks models",
      setupMethod: "single_api_key",
      group: "default",
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      category: "model",
      description: "Claude models",
      setupMethod: "single_api_key",
      group: "default",
    },
    {
      id: "openai",
      displayName: "OpenAI",
      category: "model",
      description: "GPT models",
      setupMethod: "single_api_key",
      group: "default",
    },
    {
      id: "ollama",
      displayName: "Ollama",
      category: "model",
      description: "Local models",
      setupMethod: "local",
      group: "default",
    },
  ] as const;

  it("returns all providers when runtime config is unavailable", () => {
    expect(filterModelProvidersForRuntimeConfig([...providers], null)).toEqual(
      providers,
    );
  });

  it("uses the app default provider allowlist until runtime config overrides it", () => {
    expect(
      filterModelProvidersForRuntimeConfig(
        [...providers],
        DEFAULT_RUNTIME_CONFIG,
      ),
    ).toEqual([providers[0]]);
  });

  it("returns all providers when no allowlist is configured", () => {
    expect(
      filterModelProvidersForRuntimeConfig([...providers], {
        schemaVersion: 1,
      }),
    ).toEqual(providers);
  });

  it("filters providers to the runtime config allowlist", () => {
    expect(
      filterModelProvidersForRuntimeConfig([...providers], {
        schemaVersion: 1,
        providerAllowlist: ["openai", "ollama"],
      }),
    ).toEqual([providers[2], providers[3]]);
  });

  it("ignores whitespace and empty allowlist items", () => {
    expect(
      filterModelProvidersForRuntimeConfig([...providers], {
        schemaVersion: 1,
        providerAllowlist: ["  anthropic ", "", "openai"],
      }),
    ).toEqual([providers[1], providers[2]]);
  });
});
