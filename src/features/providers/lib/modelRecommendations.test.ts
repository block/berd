import { describe, expect, it } from "vitest";
import {
  gooseModelSortRank,
  normalizedGooseModelDisplayName,
  providerModelOptionsFromIds,
  recommendedGooseModelIds,
} from "./modelRecommendations";

describe("modelRecommendations", () => {
  it("normalizes version tokens to the end of the display name", () => {
    expect(normalizedGooseModelDisplayName("goose-claude-opus-4-8")).toBe(
      "Claude Opus 4.8",
    );
    expect(normalizedGooseModelDisplayName("goose-gemini-3-5-flash")).toBe(
      "Gemini Flash 3.5",
    );
  });

  it("recommends the latest numeric version per discovered family", () => {
    expect(
      [
        ...recommendedGooseModelIds([
          "goose-claude-opus-4-7",
          "goose-claude-opus-4-8",
          "goose-gemini-3-0-flash",
          "goose-gemini-3-5-flash",
        ]),
      ].sort(),
    ).toEqual(["goose-claude-opus-4-8", "goose-gemini-3-5-flash"]);
  });

  it("puts GPT first, Opus second, unknowns in the middle, and Haiku last", () => {
    expect(gooseModelSortRank("goose-gpt-5-5")).toBe(0);
    expect(gooseModelSortRank("goose-claude-opus-4-8")).toBe(1);
    expect(gooseModelSortRank("goose-new-family-1")).toBe(2);
    expect(gooseModelSortRank("goose-claude-haiku-4-8")).toBe(3);
  });

  it("builds picker-ready options with one featured model", () => {
    const options = providerModelOptionsFromIds("databricks_v2", [
      "goose-claude-opus-4-8",
      "goose-gpt-5-5",
      "goose-gpt-5-5-mini",
      "claude-opus-4-8",
    ]);

    expect(options.map((option) => option.id)).toEqual([
      "goose-gpt-5-5",
      "goose-claude-opus-4-8",
      "claude-opus-4-8",
      "goose-gpt-5-5-mini",
    ]);
    expect(
      options.filter((option) => option.featured).map((option) => option.id),
    ).toEqual(["goose-gpt-5-5"]);
    expect(
      options.filter((option) => option.recommended).map((option) => option.id),
    ).toEqual(["goose-gpt-5-5", "goose-claude-opus-4-8", "goose-gpt-5-5-mini"]);
    expect(options.find((option) => option.id === "claude-opus-4-8")).toEqual(
      expect.objectContaining({ recommended: false, featured: false }),
    );
  });

  it("shows only the model name for Unity Catalog model ids", () => {
    const [option] = providerModelOptionsFromIds("databricks_v2", [
      "data_workflow_tools.production.fraud_detection_model",
    ]);

    expect(option).toEqual(
      expect.objectContaining({
        id: "data_workflow_tools.production.fraud_detection_model",
        name: "Fraud_detection_model",
        displayName: "Fraud_detection_model",
      }),
    );
  });

  it("does not feature or rank generic custom provider models", () => {
    const options = providerModelOptionsFromIds("block_openai_compatible", [
      "z-model",
      "a-model",
    ]);

    expect(options.map((option) => option.id)).toEqual(["z-model", "a-model"]);
    expect(options.every((option) => option.recommended)).toBe(true);
    expect(options.some((option) => option.featured)).toBe(false);
    expect(options.some((option) => option.sortOrder !== undefined)).toBe(
      false,
    );
  });
});
