import { describe, expect, it, vi } from "vitest";
import {
  beginActiveRealtimeMasterTurn,
  endActiveRealtimeMasterTurn,
  getActiveRealtimeEmissary,
  registerRealtimeEmissary,
} from "./realtimeEmissaryBridge";

describe("realtime emissary bridge registration", () => {
  it("routes only to the current live session and releases by identity", async () => {
    const sendMasterMessage = vi.fn().mockResolvedValue({
      accepted: false,
      reason: "stale_cursor",
      unreadPeerMessages: [],
      cursor: 2,
    });
    const beginMasterTurn = vi.fn();
    const endMasterTurn = vi.fn();
    const emissary = {
      sessionId: "session-1",
      beginMasterTurn,
      endMasterTurn,
      sendMasterMessage,
    };
    const release = registerRealtimeEmissary(emissary);

    expect(getActiveRealtimeEmissary()).toBe(emissary);
    await expect(
      emissary.sendMasterMessage("update", 1),
    ).resolves.toMatchObject({ accepted: false, cursor: 2 });
    expect(beginActiveRealtimeMasterTurn("session-1", "turn-1")).toBe(true);
    expect(beginMasterTurn).toHaveBeenCalledWith("turn-1");
    endActiveRealtimeMasterTurn("session-1", {
      turnId: "turn-1",
      status: "completed",
      finalText: "Finished.",
    });
    expect(endMasterTurn).toHaveBeenCalledWith({
      turnId: "turn-1",
      status: "completed",
      finalText: "Finished.",
    });

    release();
    expect(getActiveRealtimeEmissary()).toBeNull();
    expect(beginActiveRealtimeMasterTurn("session-1", "turn-2")).toBe(false);
  });
});
