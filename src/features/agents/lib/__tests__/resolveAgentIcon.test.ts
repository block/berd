import { describe, it, expect } from "vitest";
import {
  resolveAgentIcon,
  __TEST_ONLY__,
} from "@/features/agents/lib/resolveAgentIcon";

describe("resolveAgentIcon", () => {
  it("is deterministic — same id always returns the same icon", () => {
    const id = "persona-saskia";
    const a = resolveAgentIcon(id);
    const b = resolveAgentIcon(id);
    const c = resolveAgentIcon(id);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns one of the registered icons", () => {
    const icon = resolveAgentIcon("anything");
    expect(__TEST_ONLY__.AGENT_ICONS).toContain(icon);
  });

  it("spreads across all four icons for a representative sample", () => {
    const ids = [
      "saskia",
      "moneybot",
      "lulu",
      "talia",
      "code-reviewer",
      "trends-forecaster",
      "morning-assistant",
      "devil-advocate",
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
    ];

    const seen = new Set(ids.map(resolveAgentIcon));
    expect(seen.size).toBe(__TEST_ONLY__.AGENT_ICONS.length);
  });

  it("handles an empty id without throwing", () => {
    expect(() => resolveAgentIcon("")).not.toThrow();
    const icon = resolveAgentIcon("");
    expect(__TEST_ONLY__.AGENT_ICONS).toContain(icon);
  });

  it("treats different ids as (usually) distinct", () => {
    // Smoke test: two known distinct strings should not collide here.
    expect(resolveAgentIcon("persona-a")).not.toBe(
      // 'persona-c' chosen because it lands in a different bucket from 'persona-a'
      // — if hashing ever changes, update the second id to preserve the smoke check.
      resolveAgentIcon("persona-c"),
    );
  });
});
