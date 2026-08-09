import { beforeEach, describe, expect, it } from "vitest";
import type { StagedItem } from "@/shared/types/messages";
import { loadCachedStagedItems, persistStagedItems } from "./draftPersistence";

const quote: StagedItem = {
  id: "quote-1",
  kind: "quote",
  excerpt: "selected text",
  sources: [
    {
      messageId: "message-1",
      contentBlockIndex: 0,
      start: 0,
      end: 13,
    },
  ],
};

describe("staged item draft persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips staged items by session", () => {
    persistStagedItems({ "session-1": [quote] });

    expect(loadCachedStagedItems()).toEqual({ "session-1": [quote] });
  });

  it("drops invalid persisted values without losing valid sessions", () => {
    window.localStorage.setItem(
      "goose:chat-staged-items:v1",
      JSON.stringify({
        valid: [quote],
        invalid: [{ id: "bad", kind: "quote", excerpt: "", sources: [] }],
      }),
    );

    expect(loadCachedStagedItems()).toEqual({ valid: [quote] });
  });
});
