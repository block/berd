import { beforeEach, describe, expect, it } from "vitest";
import type { Message, StagedQuoteItem } from "@/shared/types/messages";
import {
  clearSubmittedStagedItems,
  loadSubmittedStagedItemRecords,
  recordSubmittedStagedItems,
  withRestoredStagedItems,
} from "./submittedQuoteProvenance";

function makeQuote(id: string, excerpt = "quoted words"): StagedQuoteItem {
  return {
    id,
    kind: "quote",
    excerpt,
    sources: [
      {
        messageId: "source-message",
        role: "assistant",
        contentBlockIndex: 0,
        start: 0,
        end: excerpt.length,
      },
    ],
  };
}

function makeUserMessage(id: string, text: string): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

function makeAssistantMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 2,
    content: [{ type: "text", text }],
  };
}

describe("submittedQuoteProvenance", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("records only quote staged items and survives reload round-trips", () => {
    recordSubmittedStagedItems("session-1", "what about this?", [
      makeQuote("quote-1"),
    ]);
    const records = loadSubmittedStagedItemRecords();
    expect(records["session-1"]).toHaveLength(1);
    expect(records["session-1"][0].matchText).toBe("what about this?");
    expect(records["session-1"][0].stagedItems[0].id).toBe("quote-1");
  });

  it("does not record turns without quotes", () => {
    recordSubmittedStagedItems("session-1", "plain message", []);
    expect(loadSubmittedStagedItemRecords()).toEqual({});
  });

  it("re-attaches staged items to the replayed user turn by prompt text", () => {
    recordSubmittedStagedItems("session-1", "what about this?", [
      makeQuote("quote-1"),
    ]);

    const restored = withRestoredStagedItems("session-1", [
      makeAssistantMessage("a-1", "an earlier answer"),
      makeUserMessage("replayed-user", "what about this?"),
    ]);

    expect(restored[1].metadata?.stagedItems?.[0]?.id).toBe("quote-1");
    // Non-matching messages pass through untouched.
    expect(restored[0].metadata?.stagedItems).toBeUndefined();
  });

  it("matches replayed text that gained surrounding whitespace", () => {
    recordSubmittedStagedItems("session-1", "what about this?", [
      makeQuote("quote-1"),
    ]);
    const restored = withRestoredStagedItems("session-1", [
      makeUserMessage("replayed-user", "  what about this?\n"),
    ]);
    expect(restored[0].metadata?.stagedItems?.[0]?.id).toBe("quote-1");
  });

  it("consumes duplicate prompt texts in send order", () => {
    recordSubmittedStagedItems("session-1", "same words", [
      makeQuote("quote-1", "first excerpt"),
    ]);
    recordSubmittedStagedItems("session-1", "same words", [
      makeQuote("quote-2", "second excerpt"),
    ]);

    const restored = withRestoredStagedItems("session-1", [
      makeUserMessage("turn-1", "same words"),
      makeUserMessage("turn-2", "same words"),
    ]);

    expect(restored[0].metadata?.stagedItems?.[0]?.id).toBe("quote-1");
    expect(restored[1].metadata?.stagedItems?.[0]?.id).toBe("quote-2");
  });

  it("never overwrites staged items a message already carries", () => {
    recordSubmittedStagedItems("session-1", "what about this?", [
      makeQuote("quote-replayed"),
    ]);
    const live = makeUserMessage("live-user", "what about this?");
    live.metadata = {
      ...live.metadata,
      stagedItems: [makeQuote("quote-live")],
    };

    const restored = withRestoredStagedItems("session-1", [live]);
    expect(restored[0].metadata?.stagedItems?.[0]?.id).toBe("quote-live");
  });

  it("leaves records unmatched when the turn was compacted away", () => {
    recordSubmittedStagedItems("session-1", "a turn compaction removed", [
      makeQuote("quote-1"),
    ]);
    const restored = withRestoredStagedItems("session-1", [
      makeUserMessage("other-turn", "a different surviving turn"),
    ]);
    expect(restored[0].metadata?.stagedItems).toBeUndefined();
  });

  it("scopes records per session", () => {
    recordSubmittedStagedItems("session-1", "shared text", [
      makeQuote("quote-1"),
    ]);
    const restored = withRestoredStagedItems("session-2", [
      makeUserMessage("turn", "shared text"),
    ]);
    expect(restored[0].metadata?.stagedItems).toBeUndefined();
  });

  it("clears a session's records on demand", () => {
    recordSubmittedStagedItems("session-1", "text", [makeQuote("quote-1")]);
    clearSubmittedStagedItems("session-1");
    expect(loadSubmittedStagedItemRecords()).toEqual({});
  });

  it("caps stored records per session, dropping oldest first", () => {
    for (let index = 0; index < 105; index += 1) {
      recordSubmittedStagedItems("session-1", `turn ${index}`, [
        makeQuote(`quote-${index}`),
      ]);
    }
    const records = loadSubmittedStagedItemRecords()["session-1"];
    expect(records).toHaveLength(100);
    expect(records[0].matchText).toBe("turn 5");
    expect(records[99].matchText).toBe("turn 104");
  });

  it("ignores corrupted storage payloads", () => {
    window.localStorage.setItem(
      "chat-submitted-staged-items",
      '{"session-1": "not-an-array"}',
    );
    expect(loadSubmittedStagedItemRecords()).toEqual({});
    // And recording on top of corruption still works.
    recordSubmittedStagedItems("session-1", "text", [makeQuote("quote-1")]);
    expect(loadSubmittedStagedItemRecords()["session-1"]).toHaveLength(1);
  });
});
