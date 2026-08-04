import { describe, expect, it } from "vitest";
import {
  normalizeDatabricksHost,
  setRuntimeConfigDatabricksHost,
} from "../../../scripts/set-runtime-config-databricks-host";
import { DEFAULT_RUNTIME_CONFIG } from "./schema";

describe("setRuntimeConfigDatabricksHost", () => {
  it("injects a validated distribution-owned host", () => {
    const configured = setRuntimeConfigDatabricksHost(
      DEFAULT_RUNTIME_CONFIG,
      "https://workspace.cloud.databricks.com",
    );

    expect(configured.goose.modelProviders[0].endpointEnv).toEqual({
      DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
    });
    expect(
      DEFAULT_RUNTIME_CONFIG.goose.modelProviders[0].endpointEnv,
    ).toBeUndefined();
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
  });

  it("rejects a runtime config without the target provider", () => {
    expect(() =>
      setRuntimeConfigDatabricksHost(
        {
          ...DEFAULT_RUNTIME_CONFIG,
          goose: {
            ...DEFAULT_RUNTIME_CONFIG.goose,
            defaultModelProviderId: "other",
            defaultModelId: undefined,
            modelProviders: [
              {
                id: "other",
                displayName: "Other",
                models: [],
              },
            ],
          },
        },
        "https://workspace.cloud.databricks.com",
      ),
    ).toThrow(/exactly one databricks_v2 provider/);
  });
});
