import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  connectedModelProviderIds,
  projectModelProviderState,
} from "./providerState";

const provider = (overrides: Partial<ProviderCatalogEntry> = {}) => ({
  id: "openai",
  displayName: "OpenAI",
  category: "model" as const,
  description: "",
  setupMethod: "config_fields" as const,
  group: "additional" as const,
  supportsInstall: false,
  supportsAuth: false,
  supportsAuthStatus: false,
  ...overrides,
});

const snapshot = (overrides = {}) => ({
  configuredIds: new Set<string>(),
  credentialedIds: new Set<string>(),
  runtimeManagedIds: new Set<string>(),
  configuredBySavedValueIds: new Set<string>(),
  ...overrides,
});

describe("provider state projection", () => {
  it.each([
    [
      "credential",
      snapshot({ credentialedIds: new Set(["openai"]) }),
      true,
      "connected",
      undefined,
    ],
    [
      "managed_endpoint",
      snapshot({
        configuredIds: new Set(["openai"]),
        runtimeManagedIds: new Set(["openai"]),
      }),
      true,
      "connected",
      undefined,
    ],
    [
      "custom",
      snapshot({ configuredIds: new Set(["openai"]) }),
      true,
      "connected",
      { customProvider: true },
    ],
    [
      "saved_settings",
      snapshot({
        configuredIds: new Set(["openai"]),
        configuredBySavedValueIds: new Set(["openai"]),
      }),
      false,
      "configured",
      undefined,
    ],
    [
      "none",
      snapshot({ configuredIds: new Set(["openai"]) }),
      false,
      "not_configured",
      undefined,
    ],
  ])("projects %s evidence once", (evidence, state, connected, status, providerOverrides) => {
    expect(
      projectModelProviderState(provider(providerOverrides ?? {}), state),
    ).toMatchObject({ evidence, connected, status });
  });

  it("uses the same connected predicate for inventory consumers", () => {
    expect(
      connectedModelProviderIds(
        [provider(), provider({ id: "managed" })],
        snapshot({
          credentialedIds: new Set(["openai"]),
          configuredIds: new Set(["managed"]),
          runtimeManagedIds: new Set(["managed"]),
        }),
      ),
    ).toEqual(["openai", "managed"]);
  });
});
