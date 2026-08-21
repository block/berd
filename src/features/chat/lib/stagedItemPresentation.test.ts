import { describe, expect, it } from "vitest";
import type { StagedQuoteItem } from "@/shared/types/messages";
import {
  stagedQuoteLabel,
  stagedQuoteMessageCount,
  stagedQuoteSourceKind,
  stagedQuoteWordCount,
} from "./stagedItemPresentation";

function quote(overrides: Partial<StagedQuoteItem> = {}): StagedQuoteItem {
  return {
    id: "quote-1",
    kind: "quote",
    excerpt: "Saturn",
    source: { messageId: "message-1", role: "assistant" },
    ...overrides,
  };
}

describe("staged quote presentation", () => {
  it("keeps short selections verbatim", () => {
    expect(stagedQuoteLabel(quote())).toBe("Saturn");
  });

  it("creates a stable verbatim anchor for long selections", () => {
    const label = stagedQuoteLabel(
      quote({ excerpt: "A deliberately long selection ".repeat(5) }),
    );
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(73);
  });

  it("describes its one logical source without replacing the excerpt", () => {
    expect(stagedQuoteMessageCount(quote())).toBe(1);
    expect(stagedQuoteSourceKind(quote())).toBe("agentResponse");
    expect(stagedQuoteWordCount(quote())).toBe(1);
    expect(
      stagedQuoteSourceKind(
        quote({ source: { messageId: "user-1", role: "user" } }),
      ),
    ).toBe("yourMessage");
  });
});
