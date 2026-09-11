import { describe, expect, it } from "vitest";
import type {
  Message,
  VoiceConversationDebugEvent,
} from "@/shared/types/messages";
import { presentRealtimeVoiceMessages } from "./realtimeVoicePresentation";

function message(id: string, event?: VoiceConversationDebugEvent): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text: id }],
    metadata: event ? { voiceConversationDebugEvent: event } : undefined,
  };
}

describe("realtime voice presentation", () => {
  const transcript = [
    message("backend"),
    message("spoken", "gptLiveSpeech"),
    message("handoff", "gptLiveToBackend"),
    message("commentary", "backendToGptLiveCommentary"),
    message("thinking", "backendToGptLiveThinking"),
  ];

  it("keeps every coordination event in debug mode", () => {
    expect(presentRealtimeVoiceMessages(transcript, "debug")).toBe(transcript);
  });

  it("presents one assistant in subtle mode", () => {
    expect(
      presentRealtimeVoiceMessages(transcript, "subtle").map(({ id }) => id),
    ).toEqual(["backend", "spoken"]);
  });

  it("keeps the original transcript when subtle mode has nothing to hide", () => {
    const ordinaryTranscript = [
      message("backend"),
      message("spoken", "gptLiveSpeech"),
    ];

    expect(presentRealtimeVoiceMessages(ordinaryTranscript, "subtle")).toBe(
      ordinaryTranscript,
    );
  });
});
