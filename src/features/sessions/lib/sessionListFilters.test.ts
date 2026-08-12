import { describe, expect, it } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import {
  NO_PROJECT_FILTER_ID,
  filterSessionsByProjects,
  filterSessionsByScope,
  selectSessionsForScope,
} from "./sessionListFilters";

function makeSession(
  overrides: Partial<ChatSession> & { id: string },
): ChatSession {
  return {
    title: `Session ${overrides.id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  } as ChatSession;
}

const active1 = makeSession({ id: "a1", projectId: "p1" });
const active2 = makeSession({ id: "a2", projectId: "p2" });
const activeNoProject = makeSession({ id: "a3" });
const activeNullProject = makeSession({ id: "a4", projectId: null });
const archived1 = makeSession({
  id: "z1",
  projectId: "p1",
  archivedAt: "2026-02-01T00:00:00.000Z",
});

const all = [active1, active2, activeNoProject, activeNullProject, archived1];

describe("filterSessionsByScope", () => {
  it("returns only sessions without archivedAt for the active scope", () => {
    expect(filterSessionsByScope(all, "active").map((s) => s.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
  });

  it("returns only sessions with archivedAt for the archived scope", () => {
    expect(filterSessionsByScope(all, "archived").map((s) => s.id)).toEqual([
      "z1",
    ]);
  });
});

describe("filterSessionsByProjects", () => {
  it("passes everything through when the set is empty", () => {
    expect(filterSessionsByProjects(all, new Set())).toEqual(all);
  });

  it("matches sessions whose projectId is in the set", () => {
    expect(
      filterSessionsByProjects(all, new Set(["p1"])).map((s) => s.id),
    ).toEqual(["a1", "z1"]);
  });

  it("supports multiple selected projects", () => {
    expect(
      filterSessionsByProjects(all, new Set(["p1", "p2"])).map((s) => s.id),
    ).toEqual(["a1", "a2", "z1"]);
  });

  it("matches sessions with no project via the sentinel", () => {
    expect(
      filterSessionsByProjects(all, new Set([NO_PROJECT_FILTER_ID])).map(
        (s) => s.id,
      ),
    ).toEqual(["a3", "a4"]);
  });

  it("combines the sentinel with real project ids", () => {
    expect(
      filterSessionsByProjects(all, new Set(["p2", NO_PROJECT_FILTER_ID])).map(
        (s) => s.id,
      ),
    ).toEqual(["a2", "a3", "a4"]);
  });
});

describe("selectSessionsForScope", () => {
  it("applies scope then the project filter", () => {
    expect(
      selectSessionsForScope(all, "active", new Set(["p1"])).map((s) => s.id),
    ).toEqual(["a1"]);
    expect(
      selectSessionsForScope(all, "archived", new Set(["p1"])).map((s) => s.id),
    ).toEqual(["z1"]);
  });

  it("passes the whole scope through when no project is selected", () => {
    expect(
      selectSessionsForScope(all, "active", new Set()).map((s) => s.id),
    ).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("counts zero when the scope holds nothing for the selected project", () => {
    // The case behind the "Archived (5)" label opening an empty tab: only p1
    // has an archived session, so filtering to p2 must be empty.
    expect(selectSessionsForScope(all, "archived", new Set(["p2"]))).toEqual(
      [],
    );
  });

  it("matches the hand-composed pipeline it replaces", () => {
    for (const scope of ["active", "archived"] as const) {
      for (const ids of [
        new Set<string>(),
        new Set(["p1"]),
        new Set(["p1", "p2"]),
        new Set([NO_PROJECT_FILTER_ID]),
      ]) {
        expect(selectSessionsForScope(all, scope, ids)).toEqual(
          filterSessionsByProjects(filterSessionsByScope(all, scope), ids),
        );
      }
    }
  });
});

describe("combined scope + project filtering", () => {
  it("applies both filters in sequence", () => {
    const activeOnly = filterSessionsByScope(all, "active");
    expect(
      filterSessionsByProjects(activeOnly, new Set(["p1"])).map((s) => s.id),
    ).toEqual(["a1"]);

    const archivedOnly = filterSessionsByScope(all, "archived");
    expect(
      filterSessionsByProjects(archivedOnly, new Set(["p1"])).map((s) => s.id),
    ).toEqual(["z1"]);
    expect(
      filterSessionsByProjects(archivedOnly, new Set([NO_PROJECT_FILTER_ID])),
    ).toEqual([]);
  });
});
