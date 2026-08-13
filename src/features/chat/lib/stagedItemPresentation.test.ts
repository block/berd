import { describe, expect, it } from "vitest";
import type { StagedQuoteItem } from "@/shared/types/messages";
import {
  stagedQuoteLabel,
  stagedQuoteSourceKind,
  stagedQuoteWordCount,
} from "./stagedItemPresentation";

function quote(overrides: Partial<StagedQuoteItem> = {}): StagedQuoteItem {
  return {
    id: "quote-1",
    kind: "quote",
    excerpt: "Saturn",
    sources: [
      {
        messageId: "message-1",
        role: "assistant",
        contentBlockIndex: 0,
        start: 0,
        end: 6,
      },
    ],
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

  it("describes source and extent without replacing the excerpt", () => {
    expect(stagedQuoteSourceKind(quote())).toBe("agentResponse");
    expect(stagedQuoteWordCount(quote())).toBe(1);
    expect(
      stagedQuoteSourceKind(
        quote({
          sources: [
            quote().sources[0],
            { ...quote().sources[0], messageId: "message-2" },
          ],
        }),
      ),
    ).toBe("multipleMessages");
  });

  it("treats multiple blocks of one message as a single-message quote", () => {
    expect(
      stagedQuoteSourceKind(
        quote({
          sources: [
            quote().sources[0],
            { ...quote().sources[0], contentBlockIndex: 1 },
          ],
        }),
      ),
    ).toBe("agentResponse");
  });
});
