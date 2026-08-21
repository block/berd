import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedItem } from "@/shared/types/messages";
import { loadCachedStagedItems, persistStagedItems } from "./draftPersistence";

const quote: StagedItem = {
  id: "quote-1",
  kind: "quote",
  excerpt: "selected text",
  source: {
    messageId: "message-1",
    role: "assistant",
  },
};

describe("staged item draft persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips staged items by session", () => {
    expect(persistStagedItems({ "session-1": [quote] })).toBe(true);
    expect(loadCachedStagedItems()).toEqual({ "session-1": [quote] });
  });

  it("reports a storage failure without changing the caller's in-memory data", () => {
    const items = { "session-1": [quote] };
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    expect(persistStagedItems(items)).toBe(false);
    expect(items["session-1"]).toEqual([quote]);
    setItem.mockRestore();
  });

  it("drops invalid persisted values without losing valid sessions", () => {
    window.localStorage.setItem(
      "goose:chat-staged-items:v2",
      JSON.stringify({
        valid: [quote],
        invalid: [{ id: "bad", kind: "quote", excerpt: "", source: null }],
      }),
    );

    expect(loadCachedStagedItems()).toEqual({ valid: [quote] });
  });
});
