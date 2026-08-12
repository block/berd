import { describe, expect, it } from "vitest";

import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";

describe("sessionWindowStore", () => {
  it("tracks which sessions are open in a window", () => {
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "a", windowLabel: "session:a" }]);

    expect(useSessionWindowStore.getState().isOpenInWindow("a")).toBe(true);
    expect(useSessionWindowStore.getState().isOpenInWindow("b")).toBe(false);
  });
});
