import { describe, expect, it } from "vitest";
import {
  CURATED_HARNESS_IDS,
  recommendationsForWorkTypes,
  RECOMMENDED_AGENTS,
  WORK_TYPES,
} from "./catalog";

describe("onboarding catalog", () => {
  it("provides four placeholder agents backed by app avatar references", () => {
    expect(RECOMMENDED_AGENTS).toHaveLength(4);
    expect(new Set(RECOMMENDED_AGENTS.map((agent) => agent.id)).size).toBe(4);
    expect(
      RECOMMENDED_AGENTS.every((agent) =>
        agent.avatar.startsWith("app-avatar:"),
      ),
    ).toBe(true);
  });

  it("maps selected work to exactly three relevant recommendations", () => {
    const recommendations = recommendationsForWorkTypes([
      "engineering",
      "design",
    ]);
    expect(recommendations).toHaveLength(3);
    expect(recommendationsForWorkTypes([])).toHaveLength(3);
  });

  it("keeps work and harness identifiers unique and curated", () => {
    expect(new Set(WORK_TYPES.map((workType) => workType.id)).size).toBe(
      WORK_TYPES.length,
    );
    expect(CURATED_HARNESS_IDS).toEqual([
      "goose",
      "claude-acp",
      "codex-acp",
      "copilot-acp",
      "amp-acp",
      "cursor-agent",
    ]);
  });
});
