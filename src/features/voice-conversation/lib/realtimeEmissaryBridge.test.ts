import { describe, expect, it, vi } from "vitest";
import {
  getActiveRealtimeEmissary,
  hasActiveRealtimeEmissary,
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
    const emissary = {
      sessionId: "session-1",
      sendMasterMessage,
    };
    const release = registerRealtimeEmissary(emissary);

    expect(getActiveRealtimeEmissary()).toBe(emissary);
    await expect(
      emissary.sendMasterMessage("update", 1, "context"),
    ).resolves.toMatchObject({ accepted: false, cursor: 2 });
    expect(hasActiveRealtimeEmissary("session-1")).toBe(true);
    expect(hasActiveRealtimeEmissary("session-2")).toBe(false);

    release();
    expect(getActiveRealtimeEmissary()).toBeNull();
    expect(hasActiveRealtimeEmissary("session-1")).toBe(false);
  });
});
