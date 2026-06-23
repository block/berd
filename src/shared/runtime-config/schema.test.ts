import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
  runtimeConfigLoadResultSchema,
  runtimeConfigSchema,
} from "./schema";

const validConfig = {
  schemaVersion: 1,
  customer: {
    id: "block",
    displayName: "Block",
  },
  workspace: {
    id: "goose-internal",
  },
  providerAllowlist: ["databricks_v2", "openai"],
  featureToggles: {
    doctor: true,
  },
  doctor: {
    enabled: true,
    kgooseConnectivity: true,
    internalToolingChecks: false,
  },
  feedback: {
    enabled: true,
    projectKey: "GOOSE",
  },
  kgoose: {
    baseUrl: "https://kgoose.example.test/",
    path: "cash-app/goose",
  },
} satisfies RuntimeConfig;

describe("runtime config schema", () => {
  it("uses databricks as the app default provider allowlist", () => {
    expect(DEFAULT_RUNTIME_CONFIG).toEqual({
      schemaVersion: 1,
      providerAllowlist: ["databricks_v2"],
    });
  });

  it("accepts the endpoint-shaped runtime config", () => {
    expect(runtimeConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("rejects invalid runtime config values", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        ...validConfig,
        providerAllowlist: ["openai", " openai "],
      }),
    ).toThrow(/providerAllowlist must not contain duplicates/);

    expect(() =>
      runtimeConfigSchema.parse({
        ...validConfig,
        kgoose: { baseUrl: "file:///tmp/kgoose" },
      }),
    ).toThrow(/http or https URL/);
  });

  it("parses ready and unavailable load results", () => {
    expect(
      runtimeConfigLoadResultSchema.parse({
        status: "ready",
        source: "fakeEndpoint",
        config: validConfig,
      }),
    ).toEqual({
      status: "ready",
      source: "fakeEndpoint",
      config: validConfig,
    });

    expect(
      runtimeConfigLoadResultSchema.parse({
        status: "unavailable",
        source: "endpoint",
        reason: "endpointUnavailable",
        message: "not implemented",
      }),
    ).toEqual({
      status: "unavailable",
      source: "endpoint",
      reason: "endpointUnavailable",
      message: "not implemented",
    });
  });
});
