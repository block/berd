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

  it("assigns strictly increasing ranks when the clock does not advance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    recordModelSelection("agent", { id: "m1" });
    recordModelSelection("agent", { id: "m2" });

    const map = getModelRecencyMap();
    expect(map["agent//m1"]).toBe(1_000);
    expect(map["agent//m2"]).toBeGreaterThan(map["agent//m1"]);
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

  it("matches exact providers and legacy providerless keys without cross-provider aliases", () => {
    const map = {
      "agent/p1/m1": 100,
      "agent//m1": 900,
      "agent//legacy": 200,
      "agent/p2/shared": 300,
      "other-agent/p1/isolated": 999,
    };

    expect(
      getModelRecencyRank(map, "agent", { id: "m1", providerId: "p1" }),
    ).toBe(100);
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

  it("does not alias stored model ids containing a slash", () => {
    const map = {
      "agent/openrouter/anthropic/claude-3": 400,
    };

    expect(
      getModelRecencyRank(map, "agent", {
        id: "anthropic/claude-3",
        providerId: "openrouter",
      }),
    ).toBe(400);
    expect(
      getModelRecencyRank(map, "agent", {
        id: "claude-3",
        providerId: "openrouter",
      }),
    ).toBeNull();
    expect(
      getModelRecencyRank(map, "agent", {
        id: "claude-3",
        providerId: "anthropic",
      }),
    ).toBeNull();
    expect(getModelRecencyRank(map, "agent", { id: "claude-3" })).toBeNull();
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

    expect(result.current).toEqual({ "agent/p1/m1": expect.any(Number) });
  });

  it("updates useModelRecency for relevant cross-window storage events", () => {
    const { result } = renderHook(() => useModelRecency());

    act(() => {
      localStorage.setItem(
        MODEL_RECENCY_STORAGE_KEY,
        JSON.stringify({ "agent/p1/m1": 1_000 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: MODEL_RECENCY_STORAGE_KEY }),
      );
    });

    expect(result.current).toEqual({ "agent/p1/m1": 1_000 });
    const snapshot = result.current;

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    });

    expect(result.current).toBe(snapshot);
  });
});
