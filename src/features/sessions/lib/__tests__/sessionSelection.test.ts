import { describe, expect, it, vi } from "vitest";
import {
  applySessionActionToIds,
  isMultiSelectModifier,
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
