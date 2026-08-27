import { describe, expect, it } from "vitest";
import { resolveDisplayModelLabel } from "./modelDisplayLabel";

const unityCatalogModelId =
  "data_workflow_tools.production.fraud_detection_model";

describe("resolveDisplayModelLabel", () => {
  it("shows only the model segment for a Databricks Unity Catalog selection", () => {
    expect(
      resolveDisplayModelLabel({
        currentModelId: unityCatalogModelId,
        currentModelName: unityCatalogModelId,
        currentModelProviderId: "databricks_v2",
      }),
    ).toBe("Fraud_detection_model");
  });

  it("repairs a persisted full Unity Catalog display name", () => {
    expect(
      resolveDisplayModelLabel({
        currentModelId: unityCatalogModelId,
        currentModelName:
          "Data_workflow_tools.production.fraud_detection_model",
        currentModelProviderId: "databricks_v2",
      }),
    ).toBe("Fraud_detection_model");
  });

  it("preserves non-Databricks model names", () => {
    expect(
      resolveDisplayModelLabel({
        currentModelId: unityCatalogModelId,
        currentModelName: "Data workflow production model",
        currentModelProviderId: "custom_provider",
      }),
    ).toBe("Data workflow production model");
  });
});
