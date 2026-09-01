import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelRecencyMap,
  getModelRecencyRank,
  MODEL_RECENCY_CHANGED_EVENT,
  MODEL_RECENCY_LIMIT,
  MODEL_RECENCY_STORAGE_KEY,
  recordModelSelection,
  useModelRecency,
} from "../modelRecency";

describe("model recency", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    getModelRecencyMap();
  });

  it("returns an empty map for missing or corrupt storage", () => {
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, "not-json{{");
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, '"a string"');
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, "[1,2,3]");
    expect(getModelRecencyMap()).toEqual({});

    const invalidKey = "agent%2Fone/provider%2Fone/model%2Fone";
    const validKey = "agent%2Fone/provider%2Fone/model%2Ftwo";
    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify({ [invalidKey]: "later", [validKey]: 42 }),
    );
    expect(getModelRecencyMap()).toEqual({ [validKey]: 42 });
  });

  it("bounds stored recency to the 50 highest-ranked entries", () => {
    const entries = Array.from({ length: 75 }, (_, rank) => [
      `agent//m${rank}`,
      rank,
    ]);
    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );

    const map = getModelRecencyMap();

    expect(Object.keys(map)).toHaveLength(MODEL_RECENCY_LIMIT);
    expect(map).toEqual(
      Object.fromEntries(entries.slice(-MODEL_RECENCY_LIMIT)),
    );
  });

  it("drops unsafe-integer ranks from storage", () => {
    const firstValidKey = "agent//first-valid";
    const unsafeKey = "agent//unsafe";
    const secondValidKey = "agent//second-valid";
    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify({
        [firstValidKey]: 41,
        [unsafeKey]: 9_007_199_254_740_992,
        [secondValidKey]: 43,
      }),
    );

    expect(getModelRecencyMap()).toEqual({
      [firstValidKey]: 41,
      [secondValidKey]: 43,
    });
  });

  it("persists selections and updates the timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordModelSelection("agent", { id: "m1", providerId: "p1" });

    let map = getModelRecencyMap();
    expect(Object.keys(map)).toHaveLength(1);
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p1" }),
    ).toBe(1_000);

    vi.setSystemTime(2_000);
    recordModelSelection("agent", { id: "m1", providerId: "p1" });

    map = getModelRecencyMap();
    expect(Object.keys(map)).toHaveLength(1);
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p1" }),
    ).toBe(2_000);

    const stored = localStorage.getItem(MODEL_RECENCY_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "")).toEqual(map);
  });

  it("assigns strictly increasing ranks when the clock does not advance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    recordModelSelection("agent", { id: "m1" });
    recordModelSelection("agent", { id: "m2" });

    const map = getModelRecencyMap();
    expect(getModelRecencyRank(map, "agent", { id: "m1" })).toBe(1_000);
    expect(getModelRecencyRank(map, "agent", { id: "m2" })).toBeGreaterThan(
      1_000,
    );
  });

  it("renormalizes ranks before incrementing Number.MAX_SAFE_INTEGER", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify({
        "agent//older": 10,
        "agent//newest": Number.MAX_SAFE_INTEGER,
      }),
    );

    recordModelSelection("agent", { id: "new-selection" });

    const map = getModelRecencyMap();
    const newRank = getModelRecencyRank(map, "agent", {
      id: "new-selection",
    });
    const otherRanks = [
      getModelRecencyRank(map, "agent", { id: "older" }),
      getModelRecencyRank(map, "agent", { id: "newest" }),
    ];
    expect(otherRanks).toEqual([1, 2]);
    expect(newRank).not.toBeNull();
    expect(newRank).toBeGreaterThan(Math.max(...otherRanks.map(Number)));
    expect(Object.values(map).every(Number.isSafeInteger)).toBe(true);
  });

  it("keeps ranks safe and ordered when seeded just below the ceiling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify({
        "agent//older": 10,
        "agent//newest": Number.MAX_SAFE_INTEGER - 1,
      }),
    );

    recordModelSelection("agent", { id: "second" });
    recordModelSelection("agent", { id: "third" });

    const map = getModelRecencyMap();
    const ranks = [
      getModelRecencyRank(map, "agent", { id: "older" }),
      getModelRecencyRank(map, "agent", { id: "newest" }),
      getModelRecencyRank(map, "agent", { id: "second" }),
      getModelRecencyRank(map, "agent", { id: "third" }),
    ];
    expect(ranks.every((rank) => rank !== null)).toBe(true);
    expect(Object.values(map).every(Number.isSafeInteger)).toBe(true);
    // The two newest selections keep their relative order.
    const secondRank = getModelRecencyRank(map, "agent", { id: "second" });
    const thirdRank = getModelRecencyRank(map, "agent", { id: "third" });
    expect(thirdRank).toBeGreaterThan(Number(secondRank));
  });

  it("does not reintroduce ceiling ranks from stale cross-window events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const staleRaw = JSON.stringify({
      "agent//older": 10,
      "agent//ceiling": Number.MAX_SAFE_INTEGER,
    });
    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, staleRaw);
    const { result } = renderHook(() => useModelRecency());

    expect(result.current).toEqual({
      "agent//older": 1,
      "agent//ceiling": 2,
    });

    act(() => {
      recordModelSelection("agent", { id: "newer" });
    });
    const localSnapshot = result.current;

    act(() => {
      localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, staleRaw);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: MODEL_RECENCY_STORAGE_KEY,
          newValue: staleRaw,
        }),
      );
    });

    const ranks = Object.values(result.current).sort(
      (left, right) => left - right,
    );
    expect(result.current).toBe(localSnapshot);
    expect(ranks.every((rank) => rank < Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(
      ranks.every((rank, index) => index === 0 || rank > ranks[index - 1]),
    ).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(MODEL_RECENCY_STORAGE_KEY) ?? ""),
    ).toEqual(result.current);
  });

  it("prunes to the newest 50 entries, dropping the oldest", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 55; i++) {
      vi.setSystemTime(1_000 + i);
      recordModelSelection("agent", { id: `m${i}` });
    }

    const map = getModelRecencyMap();
    expect(Object.keys(map)).toHaveLength(MODEL_RECENCY_LIMIT);
    for (let i = 0; i < 5; i++) {
      expect(getModelRecencyRank(map, "agent", { id: `m${i}` })).toBeNull();
    }
    for (let i = 5; i < 55; i++) {
      expect(getModelRecencyRank(map, "agent", { id: `m${i}` })).toBe(
        1_000 + i,
      );
    }
  });

  it("prunes order-shuffled storage by rank", () => {
    vi.useFakeTimers();
    const seededEntries: [string, number][] = [];
    const seededCount = MODEL_RECENCY_LIMIT + 5;

    for (let i = 0; i < seededCount; i++) {
      const rank = 1_000 + i;
      vi.setSystemTime(rank);
      recordModelSelection("agent", { id: `m${i}` });
      const entry = Object.entries(getModelRecencyMap()).find(
        ([, candidateRank]) => candidateRank === rank,
      );
      if (!entry) throw new Error(`Missing seeded rank ${rank}`);
      seededEntries.push(entry);
    }

    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...seededEntries].reverse())),
    );
    vi.setSystemTime(2_000);
    recordModelSelection("agent", { id: `m${seededCount}` });

    const map = getModelRecencyMap();
    const expectedRanks = seededEntries
      .slice(-(MODEL_RECENCY_LIMIT - 1))
      .map(([, rank]) => rank);
    expectedRanks.push(2_000);

    expect(Object.keys(map)).toHaveLength(MODEL_RECENCY_LIMIT);
    expect(Object.values(map).sort((left, right) => left - right)).toEqual(
      expectedRanks,
    );
  });

  it("matches exact providers and providerless keys without cross-provider aliases", () => {
    vi.useFakeTimers();

    vi.setSystemTime(100);
    recordModelSelection("agent", { id: "m1", providerId: "p1" });
    vi.setSystemTime(200);
    recordModelSelection("agent", { id: "legacy" });
    vi.setSystemTime(300);
    recordModelSelection("agent", { id: "shared", providerId: "p2" });
    vi.setSystemTime(900);
    recordModelSelection("agent", { id: "m1" });
    vi.setSystemTime(999);
    recordModelSelection("other-agent", { id: "isolated", providerId: "p1" });

    const map = getModelRecencyMap();
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p1" }),
    ).toBe(100);
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p3" }),
    ).toBe(900);
    expect(
      getModelRecencyRank(map, "agent", { id: "legacy", providerId: "p3" }),
    ).toBe(200);
    expect(
      getModelRecencyRank(map, "agent", { id: "shared", providerId: "p3" }),
    ).toBeNull();
    expect(
      getModelRecencyRank(map, "agent", {
        id: "isolated",
        providerId: "p1",
      }),
    ).toBeNull();
  });

  it("stores slash-delimited identities independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(400);
    recordModelSelection("agent", {
      id: "anthropic/claude-3",
      providerId: "openrouter",
    });
    vi.setSystemTime(500);
    recordModelSelection("agent", {
      id: "claude-3",
      providerId: "openrouter/anthropic",
    });

    const map = getModelRecencyMap();
    const keys = Object.keys(map);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.stringContaining("anthropic%2Fclaude-3"),
        expect.stringContaining("openrouter%2Fanthropic"),
      ]),
    );
    expect(
      getModelRecencyRank(map, "agent", {
        id: "anthropic/claude-3",
        providerId: "openrouter",
      }),
    ).toBe(400);
    expect(
      getModelRecencyRank(map, "agent", {
        id: "claude-3",
        providerId: "openrouter/anthropic",
      }),
    ).toBe(500);
    expect(
      getModelRecencyRank(map, "agent", {
        id: "claude-3",
        providerId: "openrouter",
      }),
    ).toBeNull();
  });

  it("dispatches the changed event on record", () => {
    const listener = vi.fn();
    window.addEventListener(MODEL_RECENCY_CHANGED_EVENT, listener);

    recordModelSelection("agent", { id: "m1" });

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(MODEL_RECENCY_CHANGED_EVENT, listener);
  });

  it("does not dispatch the changed event when a record is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const listener = vi.fn();
    window.addEventListener(MODEL_RECENCY_CHANGED_EVENT, listener);

    recordModelSelection("agent", { id: "m1" });
    recordModelSelection("agent", { id: "m1" });

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(MODEL_RECENCY_CHANGED_EVENT, listener);
  });

  it("re-renders useModelRecency consumers on record", () => {
    const { result } = renderHook(() => useModelRecency());
    expect(result.current).toEqual({});

    act(() => {
      recordModelSelection("agent", { id: "m1", providerId: "p1" });
    });

    expect(Object.keys(result.current)).toHaveLength(1);
    expect(
      getModelRecencyRank(result.current, "agent", {
        id: "m1",
        providerId: "p1",
      }),
    ).toEqual(expect.any(Number));
  });

  it("retains local recency when storage is read before the remote event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result } = renderHook(() => useModelRecency());

    act(() => {
      recordModelSelection("agent", { id: "local" });
    });

    const remoteRaw = JSON.stringify({ "agent//remote": 2_000 });
    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, remoteRaw);
    const snapshot = getModelRecencyMap();

    expect(snapshot).toEqual({
      "agent//local": 1_000,
      "agent//remote": 2_000,
    });
    expect(
      JSON.parse(localStorage.getItem(MODEL_RECENCY_STORAGE_KEY) ?? ""),
    ).toEqual(snapshot);

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: MODEL_RECENCY_STORAGE_KEY,
          newValue: remoteRaw,
        }),
      );
    });

    expect(result.current).toBe(snapshot);
    expect(result.current).toEqual({
      "agent//local": 1_000,
      "agent//remote": 2_000,
    });
  });

  it("merges cross-window storage events into useModelRecency", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result } = renderHook(() => useModelRecency());

    act(() => {
      for (let i = 0; i < MODEL_RECENCY_LIMIT; i++) {
        vi.setSystemTime(1_000 + i);
        recordModelSelection("agent", { id: `m${i}` });
      }
    });

    act(() => {
      localStorage.setItem(
        MODEL_RECENCY_STORAGE_KEY,
        JSON.stringify({
          "agent//m10": 2_000,
          "agent//m20": 500,
          "agent//remote": 3_000,
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: MODEL_RECENCY_STORAGE_KEY }),
      );
    });

    expect(Object.keys(result.current)).toHaveLength(MODEL_RECENCY_LIMIT);
    expect(
      getModelRecencyRank(result.current, "agent", { id: "m0" }),
    ).toBeNull();
    expect(getModelRecencyRank(result.current, "agent", { id: "m10" })).toBe(
      2_000,
    );
    expect(getModelRecencyRank(result.current, "agent", { id: "m20" })).toBe(
      1_020,
    );
    expect(getModelRecencyRank(result.current, "agent", { id: "remote" })).toBe(
      3_000,
    );
    expect(
      JSON.parse(localStorage.getItem(MODEL_RECENCY_STORAGE_KEY) ?? ""),
    ).toEqual(result.current);

    const snapshot = result.current;
    act(() => {
      localStorage.setItem(
        MODEL_RECENCY_STORAGE_KEY,
        JSON.stringify({ "agent//m10": 1_999, "agent//m20": 500 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: MODEL_RECENCY_STORAGE_KEY }),
      );
    });

    expect(result.current).toBe(snapshot);
    expect(
      JSON.parse(localStorage.getItem(MODEL_RECENCY_STORAGE_KEY) ?? ""),
    ).toEqual(snapshot);
  });
});
