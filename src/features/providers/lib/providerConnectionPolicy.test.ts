import { describe, expect, it } from "vitest";
import type { ProviderSecretDto } from "@aaif/goose-sdk";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  getCredentialedProviderIds,
  getProviderConnectionEvidence,
  hasMeaningfulSavedSettings,
  isCredentialedProvider,
} from "./providerConnectionPolicy";

function provider(
  overrides: Partial<ProviderCatalogEntry>,
): ProviderCatalogEntry {
  return {
    id: "provider",
    displayName: "Provider",
    category: "model",
    description: "Provider",
    setupMethod: "config_fields",
    group: "default",
    ...overrides,
  };
}

function secret(overrides: Partial<ProviderSecretDto>): ProviderSecretDto {
  return {
    id: "secret_store:provider:KEY",
    provider: "provider",
    providerDisplayName: "Provider",
    name: "KEY",
    storage: "secret_store",
    status: "unknown",
    configured: true,
    hasSecret: true,
    canDelete: true,
    canConfigure: false,
    ...overrides,
  };
}

function fieldValue(
  overrides: Partial<{
    key: string;
    value: string | null;
    isSet: boolean;
    isSecret: boolean;
    required: boolean;
  }>,
) {
  return {
    key: "HOST",
    value: null,
    isSet: false,
    isSecret: false,
    required: false,
    ...overrides,
  };
}

describe("getCredentialedProviderIds / isCredentialedProvider", () => {
  it("collects providers with stored secrets, ignoring empty entries", () => {
    const ids = getCredentialedProviderIds([
      secret({ provider: "openai" }),
      secret({
        provider: "huggingface",
        hasSecret: false,
        configured: false,
      }),
      secret({ provider: "github_copilot", storage: "provider_cache" }),
      secret({
        provider: "chatgpt_codex",
        storage: "provider_cache",
        status: "expired",
      }),
    ]);
    expect(ids).toEqual(new Set(["openai", "github_copilot"]));
  });

  it("matches catalog entries by id or alias", () => {
    const ids = new Set(["databricks"]);
    expect(
      isCredentialedProvider(
        { id: "databricks_v2", aliases: ["databricks"] },
        ids,
      ),
    ).toBe(true);
    expect(isCredentialedProvider({ id: "openai" }, ids)).toBe(false);
  });
});

describe("hasMeaningfulSavedSettings", () => {
  const lmStudio = provider({
    id: "lmstudio",
    fields: [
      {
        key: "HOST",
        label: "Host URL",
        secret: false,
        required: false,
        defaultValue: "http://localhost:1234",
      },
    ],
  });

  it("returns false for untouched defaults or unset values", () => {
    expect(hasMeaningfulSavedSettings(lmStudio, [fieldValue({})])).toBe(false);
    expect(
      hasMeaningfulSavedSettings(lmStudio, [
        fieldValue({ isSet: true, value: "http://localhost:1234" }),
      ]),
    ).toBe(false);
  });

  it("returns true when a non-secret value differs from the default", () => {
    expect(
      hasMeaningfulSavedSettings(lmStudio, [
        fieldValue({ isSet: true, value: "http://my-box:9999" }),
      ]),
    ).toBe(true);
  });

  it("returns true for a saved non-secret value with no default", () => {
    const bedrock = provider({
      id: "aws_bedrock",
      fields: [
        {
          key: "AWS_PROFILE",
          label: "Profile",
          secret: false,
          required: false,
        },
      ],
    });
    expect(
      hasMeaningfulSavedSettings(bedrock, [
        fieldValue({ key: "AWS_PROFILE", isSet: true, value: "work" }),
      ]),
    ).toBe(true);
  });

  it("ignores secret values but accepts saved non-secret settings on mixed providers", () => {
    const openAiCompatible = provider({
      fields: [
        { key: "API_KEY", label: "Key", secret: true, required: false },
        { key: "HOST", label: "Host", secret: false, required: false },
      ],
    });
    expect(
      hasMeaningfulSavedSettings(openAiCompatible, [
        fieldValue({ key: "API_KEY", isSet: true, isSecret: true }),
      ]),
    ).toBe(false);
    expect(
      hasMeaningfulSavedSettings(openAiCompatible, [
        fieldValue({ isSet: true, value: "https://example.com" }),
      ]),
    ).toBe(true);
  });

  it("stays conservative when a set value is unreadable", () => {
    expect(
      hasMeaningfulSavedSettings(lmStudio, [
        fieldValue({ isSet: true, value: null }),
      ]),
    ).toBe(false);
  });
});

describe("getProviderConnectionEvidence", () => {
  const configuredIds = new Set(["provider"]);

  it.each([
    {
      name: "stored credential",
      entry: provider({}),
      snapshot: {
        configuredIds: new Set<string>(),
        credentialedIds: new Set(["provider"]),
        runtimeManagedIds: new Set<string>(),
      },
      expected: "credential",
    },
    {
      name: "managed endpoint",
      entry: provider({}),
      snapshot: {
        configuredIds,
        credentialedIds: new Set<string>(),
        runtimeManagedIds: new Set(["provider"]),
      },
      expected: "managed_endpoint",
    },
    {
      name: "configured custom provider",
      entry: provider({ customProvider: true }),
      snapshot: {
        configuredIds,
        credentialedIds: new Set<string>(),
        runtimeManagedIds: new Set<string>(),
      },
      expected: "custom",
    },
    {
      name: "meaningful saved settings",
      entry: provider({}),
      snapshot: {
        configuredIds,
        credentialedIds: new Set<string>(),
        runtimeManagedIds: new Set<string>(),
        configuredBySavedValueIds: new Set(["provider"]),
      },
      expected: "saved_settings",
    },
    {
      name: "ambient configured status",
      entry: provider({}),
      snapshot: {
        configuredIds,
        credentialedIds: new Set<string>(),
        runtimeManagedIds: new Set<string>(),
      },
      expected: "none",
    },
  ])("classifies $name", ({ entry, snapshot, expected }) => {
    expect(getProviderConnectionEvidence(entry, snapshot)).toBe(expected);
  });
});
