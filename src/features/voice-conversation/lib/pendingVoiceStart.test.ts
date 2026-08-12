import { describe, expect, it } from "vitest";
import {
  cancelPendingVoiceStart,
  consumePendingVoiceStart,
  continuePendingVoiceStart,
  deferPendingVoiceStart,
} from "./pendingVoiceStart";

describe("consumePendingVoiceStart", () => {
  it("continues a deferred setup action exactly once", () => {
    const pending = { current: { sessionId: "session-1" } };

    expect(consumePendingVoiceStart(pending)).toEqual({
      sessionId: "session-1",
    });
    expect(consumePendingVoiceStart(pending)).toBeNull();
  });

  it("settles the originating action after setup succeeds", async () => {
    const pending = { current: null };
    const result = deferPendingVoiceStart(pending, {
      text: "keep this draft",
    });

    expect(
      await continuePendingVoiceStart(pending, async (payload) => {
        expect(payload).toEqual({ text: "keep this draft" });
        return true;
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(pending.current).toBeNull();
  });

  it("rejects the originating action when setup is dismissed", async () => {
    const pending = { current: null };
    const result = deferPendingVoiceStart(pending, {
      text: "keep this draft",
    });

    cancelPendingVoiceStart(pending);

    await expect(result).resolves.toBe(false);
    expect(pending.current).toBeNull();
  });
});
