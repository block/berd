import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelRecencyMap,
  getModelRecencyRank,
  MODEL_RECENCY_CHANGED_EVENT,
  MODEL_RECENCY_STORAGE_KEY,
  recordModelSelection,
  useModelRecency,
} from "../modelRecency";

describe("model recency", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("returns an empty map for missing or corrupt storage", () => {
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, "not-json{{");
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, '"a string"');
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, "[1,2,3]");
    expect(getModelRecencyMap()).toEqual({});

    localStorage.setItem(
      MODEL_RECENCY_STORAGE_KEY,
      JSON.stringify({ "agent//m1": "later", "agent//m2": 42 }),
    );
    expect(getModelRecencyMap()).toEqual({ "agent//m2": 42 });
  });

  it("persists selections and updates the timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordModelSelection("agent", { id: "m1", providerId: "p1" });
    expect(getModelRecencyMap()).toEqual({ "agent/p1/m1": 1_000 });

    vi.setSystemTime(2_000);
    recordModelSelection("agent", { id: "m1", providerId: "p1" });
    expect(getModelRecencyMap()).toEqual({ "agent/p1/m1": 2_000 });

    const stored = localStorage.getItem(MODEL_RECENCY_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "")).toEqual({ "agent/p1/m1": 2_000 });
  });

  it("prunes to the newest 50 entries, dropping the oldest", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 55; i++) {
      vi.setSystemTime(1_000 + i);
      recordModelSelection("agent", { id: `m${i}` });
    }
    const map = getModelRecencyMap();
    expect(Object.keys(map)).toHaveLength(50);
    // Only the most recent 50 selections survive: m5 through m54.
    for (let i = 0; i < 5; i++) {
      expect(map[`agent//m${i}`]).toBeUndefined();
    }
    for (let i = 5; i < 55; i++) {
      expect(map[`agent//m${i}`]).toBe(1_000 + i);
    }
  });

  it("ranks by exact key, then falls back to providerless or other-provider keys", () => {
    const map = {
      "agent/p1/m1": 100,
      "agent//m2": 200,
      "other-agent/p1/m1": 999,
    };

    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p1" }),
    ).toBe(100);
    expect(
      getModelRecencyRank(map, "agent", { id: "m2", providerId: "p2" }),
    ).toBe(200);
    expect(getModelRecencyRank(map, "agent", { id: "missing" })).toBeNull();
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p3" }),
    ).toBe(100);
  });

  it("takes the max timestamp when multiple providers share a model id", () => {
    const map = {
      "agent/p1/m1": 100,
      "agent/p2/m1": 300,
      "agent//m1": 200,
    };
    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p3" }),
    ).toBe(300);
    expect(getModelRecencyRank(map, "agent", { id: "m1" })).toBe(200);
  });

  it("dispatches the changed event on record", () => {
    const listener = vi.fn();
    window.addEventListener(MODEL_RECENCY_CHANGED_EVENT, listener);

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

    expect(result.current).toEqual({ "agent/p1/m1": expect.any(Number) });
  });
});
