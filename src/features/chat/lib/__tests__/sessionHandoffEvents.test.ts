import { describe, expect, it } from "vitest";

import type { SessionHandoffSnapshot } from "@/features/chat/lib/sessionHandoffEvents";
import type { Message } from "@/shared/types/messages";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";

describe("sessionHandoffEvents", () => {
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
      sessionId: "session-1",
      fromLabel: "main",
      toLabel: "session:abc",
      messages,
      sessionState: {
        ...INITIAL_SESSION_CHAT_RUNTIME,
        chatState: "streaming",
        streamingMessageId: "m2",
      },
    };

    const roundTrip = JSON.parse(
      JSON.stringify(payload),
    ) as SessionHandoffSnapshot;

    expect(roundTrip).toEqual(payload);
    expect(roundTrip.messages[1]?.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-1",
      arguments: { command: "pwd" },
    });
    expect(roundTrip.sessionState?.chatState).toBe("streaming");
  });
});
