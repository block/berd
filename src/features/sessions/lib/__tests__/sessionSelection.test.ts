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
});
