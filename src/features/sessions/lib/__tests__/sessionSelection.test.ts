import { describe, expect, it, vi } from "vitest";
import {
  applySessionActionToIds,
  getSessionRangeSelection,
  isMultiSelectModifier,
  isRangeSelectModifier,
  toggleSessionSelection,
} from "../sessionSelection";

describe("sessionSelection", () => {
  it("maps multi-select modifiers by platform", () => {
    expect(
      isMultiSelectModifier({ metaKey: true, ctrlKey: false }, "mac"),
    ).toBe(true);
    expect(
      isMultiSelectModifier({ metaKey: false, ctrlKey: true }, "mac"),
    ).toBe(false);
    expect(
      isMultiSelectModifier({ metaKey: false, ctrlKey: true }, "windows"),
    ).toBe(true);
  });

  it("handles active-session sidebar selection rules", () => {
    expect(
      toggleSessionSelection({
        current: new Set(),
        sessionId: "second",
        selected: true,
        activeSessionId: "active",
        activeSessionIds: new Set(["active", "second"]),
        includeActiveSessionOnStart: true,
      }),
    ).toEqual(new Set(["active", "second"]));
    expect(
      toggleSessionSelection({
        current: new Set(["active", "second"]),
        sessionId: "second",
        selected: false,
        activeSessionId: "active",
        clearActiveOnlySelection: true,
      }),
    ).toEqual(new Set());
  });

  it("treats shift as the range-select modifier", () => {
    expect(isRangeSelectModifier({ shiftKey: true })).toBe(true);
    expect(isRangeSelectModifier({ shiftKey: false })).toBe(false);
  });

  it("selects every chat between the anchor and the target", () => {
    const orderedIds = ["a", "b", "c", "d", "e"];

    expect(
      getSessionRangeSelection({
        current: new Set(["b"]),
        anchorId: "b",
        targetId: "d",
        orderedIds,
      }),
    ).toEqual(new Set(["b", "c", "d"]));

    // Ranges work upward too.
    expect(
      getSessionRangeSelection({
        current: new Set(["d"]),
        anchorId: "d",
        targetId: "a",
        orderedIds,
      }),
    ).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("keeps prior selections when extending a range", () => {
    expect(
      getSessionRangeSelection({
        current: new Set(["a", "c"]),
        anchorId: "c",
        targetId: "e",
        orderedIds: ["a", "b", "c", "d", "e"],
      }),
    ).toEqual(new Set(["a", "c", "d", "e"]));
  });

  it("falls back to selecting only the target without a usable anchor", () => {
    expect(
      getSessionRangeSelection({
        current: new Set(),
        anchorId: null,
        targetId: "c",
        orderedIds: ["a", "b", "c"],
      }),
    ).toEqual(new Set(["c"]));

    // Anchor not in the rendered list (e.g. filtered out by search).
    expect(
      getSessionRangeSelection({
        current: new Set(["z"]),
        anchorId: "z",
        targetId: "b",
        orderedIds: ["a", "b", "c"],
      }),
    ).toEqual(new Set(["z", "b"]));
  });

  it("runs every action and reports partial failures", async () => {
    const action = vi.fn((sessionId: string) => {
      if (sessionId === "bad") throw new Error("failed");
    });

    const result = await applySessionActionToIds(["first", "bad"], action);

    expect(action).toHaveBeenCalledWith("first");
    expect(action).toHaveBeenCalledWith("bad");
    expect(result).toMatchObject({ failedCount: 1 });
    expect(result?.rejectedReasons).toHaveLength(1);
  });

  it("runs actions sequentially and counts unsuccessful outcomes", async () => {
    let firstSettled = false;
    let settleFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      settleFirst = () => {
        firstSettled = true;
        resolve();
      };
    });
    const action = vi.fn((sessionId: string) => {
      if (sessionId === "first") return first;
      expect(firstSettled).toBe(true);
      return { ok: false, reason: "blocked_unsaved_changes" };
    });

    const resultPromise = applySessionActionToIds(["first", "second"], action);
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);

    settleFirst();
    const result = await resultPromise;

    expect(action).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failedCount: 1 });
  });
});
