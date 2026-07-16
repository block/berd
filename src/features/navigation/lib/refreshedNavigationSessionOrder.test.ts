import { describe, expect, it } from "vitest";

import {
  buildRefreshedNavigationRows,
  orderRefreshedNavigationProjectSessions,
  orderRefreshedNavigationSessions,
  resolveRefreshedNavigationCycleTarget,
} from "./refreshedNavigationSessionOrder";

const sessions = [
  {
    id: "newest-message",
    updatedAt: "2026-07-13T10:00:00.000Z",
    lastMessageAt: "2026-07-13T15:00:00.000Z",
  },
  {
    id: "newest-update",
    updatedAt: "2026-07-13T14:00:00.000Z",
    lastMessageAt: "2026-07-13T09:00:00.000Z",
  },
  {
    id: "oldest",
    updatedAt: "2026-07-13T08:00:00.000Z",
    lastMessageAt: "2026-07-13T08:00:00.000Z",
  },
];

describe("orderRefreshedNavigationSessions", () => {
  it("matches the refreshed sidebar's updatedAt order", () => {
    expect(
      orderRefreshedNavigationSessions(sessions, new Set()).map(
        (session) => session.id,
      ),
    ).toEqual(["newest-update", "newest-message", "oldest"]);
  });

  it("places home-pinned chats before unpinned chats", () => {
    expect(
      orderRefreshedNavigationSessions(sessions, new Set(["oldest"])).map(
        (session) => session.id,
      ),
    ).toEqual(["oldest", "newest-update", "newest-message"]);
  });

  it("does not mutate the store's session array", () => {
    const original = [...sessions];
    orderRefreshedNavigationSessions(sessions, new Set());
    expect(sessions).toEqual(original);
  });

  it("matches persisted project group and chat row order", () => {
    expect(
      orderRefreshedNavigationProjectSessions(
        sessions,
        [
          {
            id: "group-b",
            name: "Group B",
            chatIds: ["oldest", "newest-update"],
          },
          {
            id: "group-a",
            name: "Group A",
            chatIds: ["newest-message"],
          },
        ],
        new Set(["newest-message"]),
      ).map((session) => session.id),
    ).toEqual(["oldest", "newest-update", "newest-message"]);
  });

  it("resolves grouped chats by client session id", () => {
    const clientSession = {
      id: "live-id",
      clientSessionId: "draft-id",
      updatedAt: "2026-07-13T16:00:00.000Z",
    };
    expect(
      orderRefreshedNavigationProjectSessions(
        [...sessions, clientSession],
        [{ id: "group", name: "Group", chatIds: ["draft-id"] }],
        new Set(),
      )[0].id,
    ).toBe("live-id");
  });
});

describe("refreshed navigation cycle rows", () => {
  const rows = buildRefreshedNavigationRows({
    groups: [
      {
        id: "collapsed",
        expanded: false,
        items: ["hidden-a", "hidden-b"],
      },
      {
        id: "expanded",
        expanded: true,
        items: ["visible-a", "visible-b"],
      },
    ],
    ungroupedItems: ["loose"],
    getId: (id) => id,
    isSelectable: () => true,
  });

  it("skips collapsed rows in both directions", () => {
    expect(resolveRefreshedNavigationCycleTarget(rows, "visible-a", 1)).toBe(
      "visible-b",
    );
    expect(resolveRefreshedNavigationCycleTarget(rows, "visible-a", -1)).toBe(
      "loose",
    );
  });

  it("wraps across the visible selectable rows", () => {
    expect(resolveRefreshedNavigationCycleTarget(rows, "loose", 1)).toBe(
      "visible-a",
    );
    expect(resolveRefreshedNavigationCycleTarget(rows, "visible-a", -1)).toBe(
      "loose",
    );
  });

  it("moves from a collapsed active row to the next visible row", () => {
    expect(resolveRefreshedNavigationCycleTarget(rows, "hidden-b", 1)).toBe(
      "visible-a",
    );
    expect(resolveRefreshedNavigationCycleTarget(rows, "hidden-a", -1)).toBe(
      "loose",
    );
  });

  it("ignores visible rows that cannot select a real session", () => {
    const withPlaceholder = buildRefreshedNavigationRows({
      ungroupedItems: ["placeholder", "session"],
      getId: (id) => id,
      isSelectable: (id) => id !== "placeholder",
    });
    expect(
      resolveRefreshedNavigationCycleTarget(withPlaceholder, null, 1),
    ).toBe("session");
  });
});
