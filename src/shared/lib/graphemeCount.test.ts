import { describe, expect, it, vi } from "vitest";
import { graphemeCount } from "./graphemeCount";

describe("graphemeCount", () => {
  it("falls back without splitting Unicode surrogate pairs", () => {
    const segmenter = Intl.Segmenter;
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    try {
      expect(graphemeCount("😀a")).toBe(2);
    } finally {
      vi.stubGlobal("Intl", { ...Intl, Segmenter: segmenter });
    }
  });
});
