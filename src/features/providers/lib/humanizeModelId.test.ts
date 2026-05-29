import { describe, expect, it } from "vitest";
import { humanizeRawModelId } from "./humanizeModelId";

describe("humanizeRawModelId", () => {
  it("strips the goose- prefix and joins consecutive numerics with a dot", () => {
    expect(humanizeRawModelId("goose-made-up-name-1-2")).toBe(
      "Made Up Name 1.2",
    );
  });

  it("handles a numeric run sandwiched between words", () => {
    expect(humanizeRawModelId("goose-another-12-13-beta")).toBe(
      "Another 12.13 Beta",
    );
  });

  it("works without the goose- prefix", () => {
    expect(humanizeRawModelId("databricks-claude-opus-4-8")).toBe(
      "Databricks Claude Opus 4.8",
    );
  });

  it("title-cases a single word token", () => {
    expect(humanizeRawModelId("goose-haiku")).toBe("Haiku");
  });

  it("joins an all-numeric tail with dots", () => {
    expect(humanizeRawModelId("goose-1-2-3")).toBe("1.2.3");
  });

  it("treats mixed-alphanumeric tokens as words", () => {
    expect(humanizeRawModelId("goose-llama-3-1-405b")).toBe("Llama 3.1 405b");
  });

  it("returns the original id when the result would be empty", () => {
    expect(humanizeRawModelId("")).toBe("");
    expect(humanizeRawModelId("goose-")).toBe("goose-");
  });

  it("preserves GPT casing", () => {
    expect(humanizeRawModelId("gpt-4o-mini")).toBe("GPT 4o Mini");
  });

  it("preserves AWS casing", () => {
    expect(humanizeRawModelId("aws-bedrock-titan")).toBe("AWS Bedrock Titan");
  });

  it("preserves OpenAI casing", () => {
    expect(humanizeRawModelId("openai-gpt-4")).toBe("OpenAI GPT 4");
  });

  it("preserves ChatGPT casing", () => {
    expect(humanizeRawModelId("chatgpt-4o")).toBe("ChatGPT 4o");
  });

  it("matches known acronyms case-insensitively", () => {
    expect(humanizeRawModelId("GPT-4")).toBe("GPT 4");
  });
});
