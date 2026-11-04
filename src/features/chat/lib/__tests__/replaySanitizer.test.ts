import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { sanitizeReplayMessages } from "../replaySanitizer";

function createTextMessage(
  id: string,
  role: Message["role"],
  text: string,
): Message {
  return {
    id,
    role,
    created: 0,
    content: [{ type: "text", text }],
    metadata: {
      userVisible: true,
      agentVisible: role !== "system",
    },
  };
}

describe("sanitizeReplayMessages", () => {
  it("removes manual compaction control messages from replayed history", () => {
    expect(
      sanitizeReplayMessages([
        createTextMessage("user-1", "user", "Before compact"),
        createTextMessage("compact-1", "user", "/compact"),
        createTextMessage("compact-2", "user", "/compact/compact"),
        createTextMessage("compact-4", "user", "/summarize"),
        createTextMessage("assistant-1", "assistant", "After compact"),
      ]),
    ).toEqual([
      createTextMessage("user-1", "user", "Before compact"),
      createTextMessage("assistant-1", "assistant", "After compact"),
    ]);
  });

  it("keeps natural-language requests to compact the conversation", () => {
    expect(
      sanitizeReplayMessages([
        createTextMessage("user-1", "user", "Please compact this conversation"),
      ]),
    ).toEqual([
      createTextMessage("user-1", "user", "Please compact this conversation"),
    ]);
  });

  it("keeps normal user messages that merely mention compact commands", () => {
    expect(
      sanitizeReplayMessages([
        createTextMessage(
          "user-1",
          "user",
          "Can you explain what /compact does?",
        ),
      ]),
    ).toEqual([
      createTextMessage(
        "user-1",
        "user",
        "Can you explain what /compact does?",
      ),
    ]);
  });

  it("restores the user and spoken bubbles of a hidden legacy Expert wake batch", () => {
    const message = createTextMessage(
      "expert-wake",
      "user",
      "[Voice transcript; cursor 4] User said: Check my Development folder.\n" +
        "[Voice transcript; cursor 5] Spokesperson said: Let me check that.\n" +
        "[Voice transcript; cursor 6] Spokesperson said (interrupted; best effort): One mo\n" +
        "[Handoff handoff-123e4567-e89b-12d3-a456-426614174000-6 from spokesperson; cursor 7] Count the repositories.",
    );
    message.metadata = {
      ...message.metadata,
      origin: "voice_conversation",
      userVisible: false,
    };

    expect(sanitizeReplayMessages([message])).toMatchObject([
      {
        id: "expert-wake",
        role: "user",
        content: [{ type: "text", text: "Check my Development folder." }],
        metadata: { userVisible: true, agentVisible: false },
      },
      {
        id: "expert-wake:voice:1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me check that.",
            speech: { status: "spoken" },
          },
        ],
        metadata: { userVisible: true, agentVisible: false },
      },
      {
        id: "expert-wake:voice:2",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "One mo",
            speech: { status: "interrupted" },
          },
        ],
        metadata: { userVisible: true },
      },
    ]);
  });

  it("keeps voice-origin messages that are not legacy transcripts", () => {
    const message = createTextMessage("voice-1", "user", "Open the settings");
    message.metadata = { ...message.metadata, origin: "voice_conversation" };
    const handoff = createTextMessage(
      "handoff-1",
      "user",
      "[Handoff handoff-123e4567-e89b-12d3-a456-426614174000-1 from spokesperson; cursor 1] Check it.",
    );
    handoff.metadata = {
      ...handoff.metadata,
      origin: "voice_conversation",
      userVisible: false,
    };

    expect(sanitizeReplayMessages([message, handoff])).toEqual([
      message,
      handoff,
    ]);
  });

  it("keeps TTS control lookalikes that are not voice-origin messages", () => {
    const message = createTextMessage(
      "user-1",
      "user",
      "[voice: tts-delivery-failed]\n" +
        "Native TTS could not deliver the assistant reply.\n" +
        "Original text: This resembles an internal notice.\n" +
        "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.\n\n" +
        "Keep this user-authored text",
    );

    expect(sanitizeReplayMessages([message])).toEqual([message]);
  });
});
