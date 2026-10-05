import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import bundledConfig from "../../../../../distro/config.yaml?raw";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  normalizeAutoCompactThreshold,
  shouldAutoCompactContext,
} from "../autoCompact";
import { DEFAULT_CONTEXT_LIMIT, parseContextLimit } from "../contextLimit";

describe("Goose context defaults", () => {
  it("keeps packaged backend defaults and frontend fallbacks in sync", () => {
    const config = parse(bundledConfig);
    expect(config.GOOSE_CONTEXT_LIMIT).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(config.GOOSE_AUTO_COMPACT_THRESHOLD).toBe(
      DEFAULT_AUTO_COMPACT_THRESHOLD,
    );
    expect(DEFAULT_CONTEXT_LIMIT).toBe(272_000);
    expect(normalizeAutoCompactThreshold(null)).toBe(0.9);
  });

  it("compacts only above 90% of the default context budget", () => {
    expect(shouldAutoCompactContext(244_800, DEFAULT_CONTEXT_LIMIT, 0.9)).toBe(
      false,
    );
    expect(shouldAutoCompactContext(244_801, DEFAULT_CONTEXT_LIMIT, 0.9)).toBe(
      true,
    );
    expect(shouldAutoCompactContext(272_000, DEFAULT_CONTEXT_LIMIT, 1)).toBe(
      false,
    );
  });
});

describe("parseContextLimit", () => {
  it.each([
    300_000,
    "300000",
    " 300000 ",
    512,
    2_000_000,
  ])("accepts a positive integer: %s", (value) => {
    expect(parseContextLimit(value)).toBe(Number(value));
  });

  it.each([
    null,
    undefined,
    true,
    {},
    "",
    " ",
    "300000oops",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an invalid value: %s", (value) => {
    expect(parseContextLimit(value)).toBeNull();
  });
});
