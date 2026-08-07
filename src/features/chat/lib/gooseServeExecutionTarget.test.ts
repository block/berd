import { describe, expect, it } from "vitest";
import { executionTargetFromGooseServeBoundary } from "./gooseServeExecutionTarget";

describe("executionTargetFromGooseServeBoundary", () => {
  it("canonicalizes legacy agent aliases before classifying the harness", () => {
    expect(
      executionTargetFromGooseServeBoundary({
        providerId: "claude",
        modelId: "claude-fable",
      }),
    ).toEqual({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "claude-fable",
      modelName: "claude-fable",
    });
  });

  it("canonicalizes legacy model-provider aliases", () => {
    expect(
      executionTargetFromGooseServeBoundary({
        providerId: "databricks",
        modelId: "goose-gpt-5-6-sol",
      }),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-6-sol",
      modelName: "goose-gpt-5-6-sol",
    });
  });

  it("resolves a model-only legacy selection from the live target", () => {
    expect(
      executionTargetFromGooseServeBoundary(
        { modelId: "goose-gpt-5-5" },
        {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-gpt-5-6-sol",
          modelName: "GPT-5.6 Sol",
        },
      ),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "goose-gpt-5-5",
    });
  });

  it("degrades an unresolvable model-only selection without throwing", () => {
    expect(
      executionTargetFromGooseServeBoundary({ modelId: "orphaned-model" }),
    ).toEqual({ harnessId: "goose" });
  });
});
