import { describe, expect, it } from "vitest";

import {
  buildQuickSwitchResults,
  type QuickSwitchSession,
} from "./sessionQuickSwitch";

function session(
  overrides: Partial<QuickSwitchSession> & Pick<QuickSwitchSession, "id">,
): QuickSwitchSession {
  return {
    title: overrides.id,
    updatedAt: "2026-01-01T00:00:00Z",
    isRunning: false,
    ...overrides,
  };
}

describe("buildQuickSwitchResults", () => {
  it("orders by last message recency with running sessions first when query is empty", () => {
    const sessions = [
      session({
        id: "old",
        updatedAt: "2026-03-01T00:00:00Z",
        lastMessageAt: "2026-01-01T00:00:00Z",
      }),
      session({
        id: "new",
        updatedAt: "2026-01-01T00:00:00Z",
        lastMessageAt: "2026-03-01T00:00:00Z",
      }),
      session({
        id: "running-old",
        updatedAt: "2025-12-01T00:00:00Z",
        isRunning: true,
      }),
    ];

    const results = buildQuickSwitchResults(sessions, "");

    expect(results.map((r) => r.session.id)).toEqual([
      "running-old",
      "new",
      "old",
    ]);
    expect(results.every((r) => r.positions === null)).toBe(true);
  });

  it("fuzzy matches subsequences in titles", () => {
    const sessions = [
      session({ id: "a", title: "Fix login bug" }),
      session({ id: "b", title: "Refactor sidebar" }),
    ];

    const results = buildQuickSwitchResults(sessions, "flb");

    expect(results.map((r) => r.session.id)).toEqual(["a"]);
    expect(results[0].positions?.size).toBe(3);
  });

  it("excludes non-matching sessions when a query is set", () => {
    const sessions = [session({ id: "a", title: "Fix login bug" })];

    expect(buildQuickSwitchResults(sessions, "zzz")).toEqual([]);
  });

  it("boosts running sessions over similar matches", () => {
    const sessions = [
      session({ id: "idle", title: "deploy service" }),
      session({ id: "busy", title: "deploy servers", isRunning: true }),
    ];

    const results = buildQuickSwitchResults(sessions, "deploy");

    expect(results.map((r) => r.session.id)).toEqual(["busy", "idle"]);
  });

  it("orders offset ISO timestamps by actual instant", () => {
    const sessions = [
      // Later wall-clock string, but the earlier instant.
      session({ id: "earlier", updatedAt: "2026-01-01T12:00:00+09:00" }),
      session({ id: "later", updatedAt: "2026-01-01T04:00:00Z" }),
    ];

    const results = buildQuickSwitchResults(sessions, "");

    expect(results.map((r) => r.session.id)).toEqual(["later", "earlier"]);
  });

  it("falls back to updatedAt when lastMessageAt is unavailable", () => {
    const sessions = [
      session({ id: "old", updatedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "new", updatedAt: "2026-03-01T00:00:00Z" }),
    ];

    const results = buildQuickSwitchResults(sessions, "");

    expect(results.map((r) => r.session.id)).toEqual(["new", "old"]);
  });

  it("reports UTF-16 match positions for titles with surrogate pairs", () => {
    const sessions = [session({ id: "a", title: "a😀b" })];

    const results = buildQuickSwitchResults(sessions, "b");

    // "b" sits at UTF-16 index 3 because the emoji is a surrogate pair.
    expect(results[0].positions?.has(3)).toBe(true);
  });

  it("breaks score ties by last message recency", () => {
    const sessions = [
      session({
        id: "older-updated-newer-message",
        title: "Weekly sync",
        updatedAt: "2026-01-01T00:00:00Z",
        lastMessageAt: "2026-03-01T00:00:00Z",
      }),
      session({
        id: "newer-updated-older-message",
        title: "Weekly sync",
        updatedAt: "2026-02-01T00:00:00Z",
        lastMessageAt: "2026-02-15T00:00:00Z",
      }),
    ];

    const results = buildQuickSwitchResults(sessions, "weekly");

    expect(results.map((r) => r.session.id)).toEqual([
      "older-updated-newer-message",
      "newer-updated-older-message",
    ]);
  });

  it("respects the result limit", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session({ id: `s${i}` }),
    );

    expect(buildQuickSwitchResults(sessions, "", 5)).toHaveLength(5);
  });
});
