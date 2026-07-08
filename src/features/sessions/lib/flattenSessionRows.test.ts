import { describe, expect, it } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import {
  flattenFlatSessionRows,
  flattenGroupedSessionRows,
} from "./flattenSessionRows";

function makeSession(id: string): ChatSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: "2026-04-07T10:00:00Z",
    updatedAt: "2026-04-07T10:00:00Z",
    messageCount: 1,
  };
}

describe("flattenGroupedSessionRows", () => {
  it("returns empty rows for empty groups", () => {
    expect(flattenGroupedSessionRows([], 3)).toEqual([]);
  });

  it("adds a header and chunks sessions by column count", () => {
    const rows = flattenGroupedSessionRows(
      [
        {
          label: "Today",
          sessions: ["a", "b", "c", "d"].map(makeSession),
        },
      ],
      3,
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: "header", key: "h:Today", label: "Today" });
    expect(rows[1]).toMatchObject({
      kind: "cards",
      key: "r:Today:a",
    });
    expect(
      rows[1].kind === "cards" ? rows[1].sessions.map((s) => s.id) : [],
    ).toEqual(["a", "b", "c"]);
    expect(
      rows[2].kind === "cards" ? rows[2].sessions.map((s) => s.id) : [],
    ).toEqual(["d"]);
  });

  it("normalizes invalid column counts to one column", () => {
    const rows = flattenGroupedSessionRows(
      [{ label: "Today", sessions: ["a", "b"].map(makeSession) }],
      0,
    );

    expect(rows).toHaveLength(3);
  });

  it("accumulates cardOffset continuously across rows and groups", () => {
    const rows = flattenGroupedSessionRows(
      [
        { label: "Today", sessions: ["a", "b", "c", "d"].map(makeSession) },
        { label: "Yesterday", sessions: ["e", "f"].map(makeSession) },
      ],
      3,
    );

    const cardOffsets = rows.flatMap((row) =>
      row.kind === "cards" ? [row.cardOffset] : [],
    );
    // Today: rows start at 0 and 3 (3 + 1 cards); Yesterday: starts at 4.
    expect(cardOffsets).toEqual([0, 3, 4]);
  });
});

describe("flattenFlatSessionRows", () => {
  it("returns empty rows for no items", () => {
    expect(flattenFlatSessionRows([], 2)).toEqual([]);
  });

  it("chunks flat items while keeping item metadata parallel to sessions", () => {
    const items = ["a", "b", "c"].map((id) => ({
      session: makeSession(id),
      snippet: `snippet ${id}`,
    }));

    const rows = flattenFlatSessionRows(items, 2);

    expect(rows).toHaveLength(2);
    expect(rows[0].items.map((item) => item.snippet)).toEqual([
      "snippet a",
      "snippet b",
    ]);
    expect(rows[0].key).toBe("r:a");
    expect(rows[0].items.map((item) => item.session.id)).toEqual(["a", "b"]);
    expect(rows[1].items.map((item) => item.snippet)).toEqual(["snippet c"]);
    expect(rows.map((row) => row.cardOffset)).toEqual([0, 2]);
  });
});
