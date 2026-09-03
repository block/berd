import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { VOICE_CONVERSATION_EMPTY_RESPONSE } from "@/features/chat/lib/voiceConversationNoop";
import { getVisibleTranscriptMessages } from "./buildTranscriptItems";

function message(
  id: string,
  role: Message["role"],
  text: string,
  origin?: "voice_conversation",
): Message {
  return {
    id,
    role,
    created: 1,
    content: [{ type: "text", text }],
    metadata: origin ? { origin } : undefined,
  };
}

describe("getVisibleTranscriptMessages voice no-op", () => {
  it("does not inspect assistant text in a transcript without voice turns", () => {
    const inaccessibleText = { type: "text" } as {
      type: "text";
      text: string;
    };
    Object.defineProperty(inaccessibleText, "text", {
      get: () => {
        throw new Error("text-only projection must use the fast path");
      },
    });
    const assistant: Message = {
      id: "assistant",
      role: "assistant",
      created: 1,
      content: [inaccessibleText],
    };

    expect(getVisibleTranscriptMessages([assistant])).toEqual([assistant]);
  });

  it("hides the backend empty-response fallback after a voice turn", () => {
    const voice = message(
      "voice",
      "user",
      "Emissary said: Hello",
      "voice_conversation",
    );
    const fallback = message(
      "fallback",
      "assistant",
      VOICE_CONVERSATION_EMPTY_RESPONSE,
    );

    expect(getVisibleTranscriptMessages([voice, fallback])).toEqual([voice]);
  });

  it("hides an empty-response system notification after a voice turn", () => {
    const voice = message(
      "voice",
      "user",
      "Emissary said: Hello",
      "voice_conversation",
    );
    const fallback: Message = {
      id: "fallback",
      role: "system",
      created: 1,
      content: [
        {
          type: "systemNotification",
          notificationType: "error",
          text: VOICE_CONVERSATION_EMPTY_RESPONSE,
        },
      ],
    };

    expect(getVisibleTranscriptMessages([voice, fallback])).toEqual([voice]);
  });

  it("hides replayed and localized empty-response fallbacks after a voice transcript", () => {
    const voice = message(
      "voice",
      "user",
      "[Voice transcript] Emissary said: Bonjour",
    );
    const fallback = message(
      "fallback",
      "assistant",
      "Le modèle a renvoyé une réponse vide. Veuillez renvoyer votre message pour continuer.",
    );

    expect(getVisibleTranscriptMessages([voice, fallback])).toEqual([voice]);
  });

  it("keeps the same fallback visible after a normal chat turn", () => {
    const user = message("user", "user", "Hello");
    const fallback = message(
      "fallback",
      "assistant",
      VOICE_CONVERSATION_EMPTY_RESPONSE,
    );

    expect(getVisibleTranscriptMessages([user, fallback])).toEqual([
      user,
      fallback,
    ]);
  });

  it("keeps real assistant errors visible after a voice turn", () => {
    const voice = message(
      "voice",
      "user",
      "User said: Hello",
      "voice_conversation",
    );
    const error = message("error", "assistant", "Authentication failed");

    expect(getVisibleTranscriptMessages([voice, error])).toEqual([
      voice,
      error,
    ]);
  });

  it("never renders a transient empty-response fallback inside spoken Emissary text", () => {
    const voice = message(
      "voice",
      "user",
      "How many months are in a year?",
      "voice_conversation",
    );
    const spoken: Message = {
      id: "spoken",
      role: "assistant",
      created: 2,
      content: [
        {
          type: "text",
          text: `There are 12 months in a year.${VOICE_CONVERSATION_EMPTY_RESPONSE}`,
          speech: { status: "spoken" },
        },
      ],
      metadata: {
        origin: "voice_conversation",
        voiceConversationDebugEvent: "emissarySpeech",
      },
    };

    expect(getVisibleTranscriptMessages([voice, spoken])).toEqual([
      voice,
      {
        ...spoken,
        content: [
          {
            type: "text",
            text: "There are 12 months in a year.",
            speech: { status: "spoken" },
          },
        ],
      },
    ]);
  });

  it("sanitizes spoken assistant text even when the user typed during a voice call", () => {
    const user = message("user", "user", "Are you still there?");
    const spoken: Message = {
      id: "spoken",
      role: "assistant",
      created: 2,
      content: [
        {
          type: "text",
          text: `Yes, I'm here.${VOICE_CONVERSATION_EMPTY_RESPONSE}`,
          speech: { status: "spoken" },
        },
      ],
    };

    expect(getVisibleTranscriptMessages([user, spoken])).toEqual([
      user,
      {
        ...spoken,
        content: [
          {
            type: "text",
            text: "Yes, I'm here.",
            speech: { status: "spoken" },
          },
        ],
      },
    ]);
  });
});
