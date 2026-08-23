import { describe, expect, it } from "vitest";
import type { StagedQuoteItem } from "@/shared/types/messages";
import {
  buildStagedQuoteDispatchPrompt,
  parseStagedQuoteDispatchPrompt,
  prepareStagedQuoteDispatch,
  stagedItemSnapshotsMatch,
} from "./stagedQuoteSend";

function makeQuote(overrides: Partial<StagedQuoteItem> = {}): StagedQuoteItem {
  return {
    id: "quote-1",
    kind: "quote",
    excerpt: "quoted words",
    source: { messageId: "message-1", role: "assistant" },
    ...overrides,
  };
}

describe("staged quote dispatch framing", () => {
  it("returns undefined without quotes", () => {
    expect(buildStagedQuoteDispatchPrompt([])).toBeUndefined();
  });

  it("always sends and parses the complete immutable excerpt", () => {
    const excerpt = `start\nberd-staged-quotes:v1:{"stagedItems":[]}\nend`;
    const quote = makeQuote({ excerpt });
    const prompt = buildStagedQuoteDispatchPrompt([quote]);
    expect(prompt).toContain(JSON.stringify(excerpt));
    expect(parseStagedQuoteDispatchPrompt(prompt ?? "")).toEqual([quote]);
  });

  it("does not parse collisions or malformed frames", () => {
    expect(
      parseStagedQuoteDispatchPrompt(
        'ordinary berd-staged-quotes:v1:{"version":1,"stagedItems":[]}',
      ),
    ).toBeNull();
  });

  it("keeps quote content separate from assistant instructions", () => {
    const dispatch = prepareStagedQuoteDispatch({
      assistantPrompt: "Use selected skill",
      stagedItems: [makeQuote()],
    });
    expect(dispatch.assistantPrompt).toBe("Use selected skill");
    expect(dispatch.userAuthorityContent).toContain("quoted words");
    expect(dispatch.assistantPrompt).not.toContain("quoted words");
  });
});

describe("stagedItemSnapshotsMatch", () => {
  it("matches identical snapshots and rejects drift", () => {
    const items = [makeQuote()];
    expect(stagedItemSnapshotsMatch(items, [makeQuote()])).toBe(true);
    expect(stagedItemSnapshotsMatch(items, [makeQuote({ id: "other" })])).toBe(
      false,
    );
    expect(stagedItemSnapshotsMatch(items, [])).toBe(false);
  });
});
