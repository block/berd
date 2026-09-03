import { describe, expect, it } from "vitest";
import { noticerTargetForCompletedTurn } from "../useMemoryNoticer";

describe("noticerTargetForCompletedTurn", () => {
  it("uses the completed Goose session's exact provider and model", () => {
    expect(
      noticerTargetForCompletedTurn("streaming", "idle", {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet",
        modelName: "Claude Sonnet",
      }),
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet" });
  });

  it("skips external harnesses instead of falling back", () => {
    expect(
      noticerTargetForCompletedTurn("streaming", "idle", {
        harnessId: "claude-acp",
      }),
    ).toBeNull();
  });

  it("only schedules when an active turn becomes idle", () => {
    const target = {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt",
      modelName: "GPT",
    } as const;
    expect(noticerTargetForCompletedTurn("idle", "idle", target)).toBeNull();
    expect(
      noticerTargetForCompletedTurn("thinking", "idle", target),
    ).not.toBeNull();
  });
});
