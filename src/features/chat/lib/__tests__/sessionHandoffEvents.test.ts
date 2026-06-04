import { describe, expect, it } from "vitest";

import type { SessionHandoffSnapshotAvailable } from "@/features/chat/lib/sessionHandoffEvents";
import type { SessionHandoffSnapshot } from "@/features/chat/lib/sessionWindowCommands";
import type { Message } from "@/shared/types/messages";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";

describe("sessionHandoffEvents", () => {
  it("preserves snapshot availability hints through a JSON round trip", () => {
    const payload: SessionHandoffSnapshotAvailable = {
      sessionId: "session-1",
      toLabel: "session:abc",
      version: 2,
      isFinal: true,
    };

    const roundTrip = JSON.parse(
      JSON.stringify(payload),
    ) as SessionHandoffSnapshotAvailable;

    expect(roundTrip).toEqual(payload);
  });

  it("preserves snapshot fields through a JSON round trip", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "hello" }],
      },
      {
        id: "m2",
        role: "assistant",
        created: 2,
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "shell",
            arguments: { command: "pwd" },
            status: "completed",
          },
        ],
      },
    ];
    const payload: SessionHandoffSnapshot = {
      version: 1,
      isFinal: false,
      payload: {
        sessionId: "session-1",
        fromLabel: "main",
        toLabel: "session:abc",
        messages,
        sessionState: {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m2",
        },
      },
    };

    const roundTrip = JSON.parse(
      JSON.stringify(payload),
    ) as SessionHandoffSnapshot;

    expect(roundTrip).toEqual(payload);
    expect(roundTrip.payload.messages[1]?.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-1",
      arguments: { command: "pwd" },
    });
    expect(roundTrip.payload.sessionState?.chatState).toBe("streaming");
  });
});
