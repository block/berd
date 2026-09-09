import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRealtimeEmissary } from "@/features/voice-conversation/lib/realtimeEmissaryBridge";
import { CommandError } from "../types";
import { dismissHandoffsSessionCommand } from "./dismissHandoffsSession";
import { sendToSpokespersonSessionCommand } from "./sendToSpokespersonSession";

let releaseBridge: (() => void) | undefined;

afterEach(() => {
  releaseBridge?.();
  releaseBridge = undefined;
});

describe("Realtime handoff commands", () => {
  it("forwards every resolved handoff id through send-to-spokesperson", async () => {
    const sendMasterMessage = vi.fn().mockResolvedValue({
      accepted: true,
      cursor: 2,
      deliveryStatus: "sent",
      outbound: {
        id: 3,
        sender: "master",
        recipient: "emissary",
        senderCursor: 2,
        message: "Both checks are complete.",
      },
    });
    releaseBridge = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage,
      dismissHandoffs: vi.fn(),
      completeMasterTurn: vi.fn(),
    });
    const args = sendToSpokespersonSessionCommand.schema.parse({
      session_id: "session-1",
      cursor: 2,
      mode: "say",
      message: "Both checks are complete.",
      resolves: ["handoff-1", "handoff-2"],
    });

    await expect(
      sendToSpokespersonSessionCommand.execute(args, {}),
    ).resolves.toEqual({
      session_id: "session-1",
      cursor: 2,
      delivery_status: "sent",
      mode: "say",
      resolved_handoff_ids: ["handoff-1", "handoff-2"],
    });
    expect(sendMasterMessage).toHaveBeenCalledWith(
      "Both checks are complete.",
      2,
      "say",
      ["handoff-1", "handoff-2"],
    );
  });

  it("reports unknown handoff ids from send-to-spokesperson", async () => {
    releaseBridge = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn().mockResolvedValue({
        accepted: false,
        reason: "unknown_handoff",
        cursor: 2,
        handoffIds: ["handoff-9"],
      }),
      dismissHandoffs: vi.fn(),
      completeMasterTurn: vi.fn(),
    });
    const args = sendToSpokespersonSessionCommand.schema.parse({
      session_id: "session-1",
      cursor: 2,
      mode: "say",
      message: "Done.",
      resolves: ["handoff-9"],
    });

    const error = await sendToSpokespersonSessionCommand
      .execute(args, {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "invalid_args" });
    expect(JSON.parse((error as Error).message)).toEqual({
      reason: "unknown_handoff",
      cursor: 2,
      handoff_ids: ["handoff-9"],
    });
  });

  it("dismisses multiple handoffs with silent context delivery status", async () => {
    const sendMasterMessage = vi.fn();
    const dismissHandoffs = vi.fn().mockResolvedValue({
      accepted: true,
      cursor: 2,
      dismissedHandoffIds: ["handoff-1", "handoff-2"],
      deliveryStatus: "sent",
    });
    releaseBridge = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage,
      dismissHandoffs,
      completeMasterTurn: vi.fn(),
    });
    const args = dismissHandoffsSessionCommand.schema.parse({
      session_id: "session-1",
      cursor: 2,
      handoff_id: ["handoff-1", "handoff-2"],
      reason: "The user withdrew both requests.",
    });

    await expect(
      dismissHandoffsSessionCommand.execute(args, {}),
    ).resolves.toEqual({
      session_id: "session-1",
      cursor: 2,
      dismissed_handoff_ids: ["handoff-1", "handoff-2"],
      context_delivery_status: "sent",
    });
    expect(dismissHandoffs).toHaveBeenCalledWith(
      2,
      ["handoff-1", "handoff-2"],
      "The user withdrew both requests.",
    );
    expect(sendMasterMessage).not.toHaveBeenCalled();
  });
});
