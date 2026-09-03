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

  it("restores batched realtime transcripts to user and spoken Spokesperson bubbles", () => {
    const message = createTextMessage(
      "voice-batch",
      "user",
      "[Voice transcript] Spokesperson said: Let me check.\n" +
        "[Voice transcript] Spokesperson said (interrupted; best-effort transcript): One moment.\n" +
        "[Voice transcript] User said: What did you find?",
    );
    message.metadata = {
      ...message.metadata,
      origin: "voice_conversation",
    };

    expect(sanitizeReplayMessages([message])).toMatchObject([
      {
        id: "voice-batch",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me check.",
            speech: { status: "spoken" },
          },
        ],
        metadata: {
          userVisible: true,
          agentVisible: false,
          voiceConversationDebugEvent: "emissarySpeech",
        },
      },
      {
        id: "voice-batch:voice:1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "One moment.",
            speech: { status: "interrupted", confidence: "low" },
          },
        ],
        metadata: { voiceConversationDebugEvent: "emissarySpeech" },
      },
      {
        id: "voice-batch:voice:2",
        role: "user",
        content: [{ type: "text", text: "What did you find?" }],
        metadata: { userVisible: true, agentVisible: false },
      },
    ]);
  });

  it("restores a current Expert wake batch with cursors and a handoff", () => {
    const handoffId = "handoff-123e4567-e89b-12d3-a456-426614174000-6";
    const message = createTextMessage(
      "expert-wake",
      "user",
      "[Voice transcript; cursor 4] User said: Check my Development folder.\n" +
        "[Voice transcript; cursor 5] Spokesperson said: Let me check that.\n" +
        `[Handoff ${handoffId} from spokesperson; cursor 6] Count the repositories.`,
    );
    message.metadata = {
      ...message.metadata,
      origin: "voice_conversation",
      userVisible: false,
    };

    expect(sanitizeReplayMessages([message])).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Check my Development folder." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me check that.",
            speech: { status: "spoken" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Count the repositories." }],
        metadata: {
          personaName: "Spokesperson → Expert",
          voiceConversationDebugEvent: "emissaryToMaster",
        },
      },
    ]);
  });

  it("restores persisted Spokesperson handoffs as coordination bubbles", () => {
    const handoffId = "handoff-123e4567-e89b-12d3-a456-426614174000-1";
    const message = createTextMessage(
      "direct-message",
      "user",
      `[Handoff ${handoffId} from spokesperson; cursor 1] Check the transcript storage.`,
    );
    message.metadata = {
      ...message.metadata,
      origin: "voice_conversation",
      userVisible: false,
    };

    expect(sanitizeReplayMessages([message])).toMatchObject([
      {
        id: "direct-message",
        role: "assistant",
        content: [{ type: "text", text: "Check the transcript storage." }],
        metadata: {
          personaName: "Spokesperson → Expert",
          userVisible: true,
          agentVisible: false,
          voiceConversationDebugEvent: "emissaryToMaster",
        },
      },
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
