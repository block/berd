import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyDistributionValues,
  normalizeDatabricksHost,
  normalizeFastModelId,
} from "../../../scripts/set-runtime-config-distribution";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "./schema";

const HOST = "https://workspace.cloud.databricks.com";

const DISTRIBUTION_RUNTIME_CONFIG: RuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks AI Gateway",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
    ],
  },
};

describe("applyDistributionValues", () => {
  it("injects a validated distribution-owned host", () => {
    const configured = applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
      databricksHost: HOST,
    });

    expect(configured.goose.modelProviders[0].endpointEnv).toEqual({
      DATABRICKS_HOST: HOST,
    });
    expect(
      DISTRIBUTION_RUNTIME_CONFIG.goose.modelProviders[0].endpointEnv,
    ).toBeUndefined();
  });

  it("leaves fastModelId absent when only a host is supplied", () => {
    const configured = applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
      databricksHost: HOST,
    });

    expect(configured.goose.modelProviders[0].fastModelId).toBeUndefined();
  });

  it("injects a validated distribution-owned fast model on its own", () => {
    const configured = applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
      fastModelId: "goose-claude-haiku-4-5",
    });

    expect(configured.goose.modelProviders[0].fastModelId).toBe(
      "goose-claude-haiku-4-5",
    );
    expect(configured.goose.modelProviders[0].endpointEnv).toBeUndefined();
    expect(
      DISTRIBUTION_RUNTIME_CONFIG.goose.modelProviders[0].fastModelId,
    ).toBeUndefined();
  });

  it("injects both values in a single pass", () => {
    const configured = applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
      databricksHost: HOST,
      fastModelId: "goose-claude-haiku-4-5",
    });

    expect(configured.goose.modelProviders[0].endpointEnv).toEqual({
      DATABRICKS_HOST: HOST,
    });
    expect(configured.goose.modelProviders[0].fastModelId).toBe(
      "goose-claude-haiku-4-5",
    );
  });

  it.each([
    "http://workspace.cloud.databricks.com",
    "https://user@workspace.cloud.databricks.com",
    "https://workspace.cloud.databricks.com:443",
    "https://workspace.cloud.databricks.com/path",
    "https://workspace.cloud.databricks.com?query=value",
    "https://workspace.cloud.databricks.com#fragment",
    "https://workspace.cloud.databricks.com/",
    " https://workspace.cloud.databricks.com",
  ])("rejects non-canonical or unsafe host %s", (host) => {
    expect(() => normalizeDatabricksHost(host)).toThrow(/DATABRICKS_HOST/);
    expect(() =>
      applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
        databricksHost: host,
      }),
    ).toThrow(/DATABRICKS_HOST/);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading whitespace", " goose-claude-haiku-4-5"],
    ["trailing whitespace", "goose-claude-haiku-4-5 "],
    ["leading punctuation", "-goose-claude-haiku-4-5"],
    ["shell metacharacter", "goose-claude-haiku-4-5; rm -rf /"],
    ["space separated", "goose claude haiku"],
    ["newline", "goose-claude-haiku-4-5\n"],
    ["over length", `goose-${"a".repeat(128)}`],
  ])("rejects a %s fast model id", (_label, id) => {
    expect(() => normalizeFastModelId(id)).toThrow(/FAST_MODEL_ID/);
    expect(() =>
      applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, { fastModelId: id }),
    ).toThrow(/FAST_MODEL_ID/);
  });

  it("accepts a served endpoint id that is not in the provider's models", () => {
    const configured = applyDistributionValues(DISTRIBUTION_RUNTIME_CONFIG, {
      fastModelId: "goose-claude-haiku-4-5",
    });

    const provider = configured.goose.modelProviders[0];
    expect(provider.models.map((model) => model.id)).not.toContain(
      provider.fastModelId,
    );
  });

  function configWithProviders(providers: unknown[]) {
    return {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        defaultModelProviderId: "other",
        defaultModelId: undefined,
        modelProviders: [
          { id: "other", displayName: "Other", models: [] },
          ...providers,
        ],
      },
    };
  }

  it("rejects a runtime config without the target provider", () => {
    expect(() =>
      applyDistributionValues(configWithProviders([]), {
        databricksHost: HOST,
        fastModelId: "goose-claude-haiku-4-5",
      }),
    ).toThrow(/exactly one databricks_v2 provider/);
  });

  it("rejects a runtime config with a duplicated target provider", () => {
    expect(() =>
      applyDistributionValues(
        configWithProviders([
          { id: "databricks_v2", displayName: "A", models: [] },
          { id: "databricks_v2", displayName: "B", models: [] },
        ]),
        { databricksHost: HOST, fastModelId: "goose-claude-haiku-4-5" },
      ),
    ).toThrow(/databricks_v2/);
  });
});

// build-macos.sh has no other automated coverage, and the BYO strip is the one
// place where distribution-owned policy could leak into a bundle that must not
// carry it. Pin both del() clauses so removing one fails here.
describe("build-macos.sh BYO strip", () => {
  it("deletes the injected host, fast model, and model prefix policy", () => {
    const script = readFileSync("scripts/release/build-macos.sh", "utf8");
    const byoStripStart = script.indexOf(
      'VITE_BYO_KEY_PROVIDERS_VALUE" == "1"',
    );
    expect(byoStripStart).toBeGreaterThan(-1);

    const byoStrip = script.slice(byoStripStart);
    expect(byoStrip).toContain("del(.DATABRICKS_HOST)");
    expect(byoStrip).toContain("del(.fastModelId, .allowedModelIdPrefixes)");
  });
});
