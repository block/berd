import { describe, expect, it } from "vitest";
import {
  segmentCardGraphemes,
  segmentCardWrapUnits,
  truncateCardGraphemes,
} from "./agentShareCardText";

describe("agentShareCardText", () => {
  it("keeps user-perceived graphemes intact", () => {
    const graphemes = ["e\u0301", "👍🏽", "🇺🇸", "👨‍👩‍👧‍👦"];
    for (const grapheme of graphemes) {
      expect(segmentCardGraphemes(grapheme)).toEqual([grapheme]);
      expect(truncateCardGraphemes(`${grapheme}x`, 1)).toBe(grapheme);
    }
  });

  it("provides line-break units for text without whitespace", () => {
    expect(segmentCardWrapUnits("你好世界", "zh")).toEqual(["你好", "世界"]);
  });
});
