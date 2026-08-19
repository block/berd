import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

const mocks = vi.hoisted(() => ({
  speakPocketVoice: vi.fn<(text: string) => Promise<void>>(),
  stopPocketVoice: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../api/pocketVoice", () => mocks);

import {
  startNativeAssistantSpeech,
  stopNativeAssistantSpeech,
  takeVoicePlaybackNotices,
} from "./nativeAssistantSpeech";

function assistant(
  content: Message["content"],
  completionStatus: NonNullable<
    Message["metadata"]
  >["completionStatus"] = "inProgress",
): Message {
  return {
    id: "assistant-1",
    role: "assistant",
    created: 1,
    content,
    metadata: { completionStatus },
  };
}

describe("native assistant speech queue", () => {
  beforeEach(() => {
    mocks.speakPocketVoice.mockReset();
    mocks.stopPocketVoice.mockReset().mockResolvedValue(true);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        revision: 1,
      },
      uiState: "listening",
      userSpeaking: false,
      assistantSpeaking: false,
    });
  });

  afterEach(() => {
    stopNativeAssistantSpeech();
  });

  it("plays rapid assistant blocks exactly once in transcript order", async () => {
    let finishFirst: (() => void) | undefined;
    mocks.speakPocketVoice
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce();
    startNativeAssistantSpeech("session-1", vi.fn());

    useChatStore.getState().setMessages("session-1", [
      assistant(
        [
          { type: "text", text: "First block." },
          {
            type: "toolRequest",
            id: "tool-1",
            name: "Read",
            arguments: {},
            status: "completed",
          },
          { type: "text", text: "Second block." },
        ],
        "completed",
      ),
    ]);

    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(1);
    });
    expect(mocks.speakPocketVoice).toHaveBeenNthCalledWith(1, "First block.");
    finishFirst?.();
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(2);
    });
    expect(mocks.speakPocketVoice).toHaveBeenNthCalledWith(2, "Second block.");
    await vi.waitFor(() => {
      const content =
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content;
      expect(content?.[0]).toMatchObject({ speech: { status: "spoken" } });
      expect(content?.[2]).toMatchObject({ speech: { status: "spoken" } });
    });
  });

  it("starts speaking complete sentences while the response is streaming", async () => {
    mocks.speakPocketVoice.mockResolvedValue();
    startNativeAssistantSpeech("session-1", vi.fn());

    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "The first sentence is ready." }]),
      ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledWith(
        "The first sentence is ready.",
      );
    });

    useChatStore
      .getState()
      .appendStreamingText(
        "session-1",
        "assistant-1",
        " The second is still streaming",
      );
    await Promise.resolve();
    expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).not.toHaveProperty("speech");

    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", "!");
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenNthCalledWith(
        2,
        "The second is still streaming!",
      );
    });
  });

  it("waits through abbreviations before speaking a streamed sentence", async () => {
    mocks.speakPocketVoice.mockResolvedValue();
    startNativeAssistantSpeech("session-1", vi.fn());

    useChatStore.getState().setMessages("session-1", [
      assistant([
        {
          type: "text",
          text: "Dr. Smith is reviewing the U.S.",
        },
      ]),
    ]);
    await Promise.resolve();
    expect(mocks.speakPocketVoice).not.toHaveBeenCalled();

    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " economy.");
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledWith(
        "Dr. Smith is reviewing the U.S. economy.",
      );
    });
  });

  it("flushes an unfinished streamed sentence when the response completes", async () => {
    mocks.speakPocketVoice.mockResolvedValue();
    startNativeAssistantSpeech("session-1", vi.fn());

    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "An unfinished tail" }]),
      ]);
    await Promise.resolve();
    expect(mocks.speakPocketVoice).not.toHaveBeenCalled();

    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "An unfinished tail" }], "completed"),
      ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledWith("An unfinished tail");
    });
  });

  it("speaks text at tool boundaries even when tools normalize before text", async () => {
    mocks.speakPocketVoice.mockResolvedValue();
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First block" }]),
      ]);
    await Promise.resolve();
    expect(mocks.speakPocketVoice).not.toHaveBeenCalled();

    useChatStore.getState().setMessages("session-1", [
      assistant([
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Read",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "First block" },
      ]),
    ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledWith("First block");
    });

    useChatStore.getState().setMessages("session-1", [
      assistant([
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Read",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "First block Second block" },
      ]),
    ]);
    await Promise.resolve();
    expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(1);

    useChatStore.getState().setMessages("session-1", [
      assistant([
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Read",
          arguments: {},
          status: "completed",
        },
        {
          type: "toolRequest",
          id: "tool-2",
          name: "Read again",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "First block Second block" },
      ]),
    ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenNthCalledWith(2, "Second block");
    });
  });

  it("marks the active and queued blocks interrupted on barge-in", async () => {
    let finishFirst: (() => void) | undefined;
    mocks.speakPocketVoice.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore.getState().setMessages("session-1", [
      assistant(
        [
          { type: "text", text: "First block." },
          {
            type: "toolRequest",
            id: "tool-1",
            name: "Read",
            arguments: {},
            status: "completed",
          },
          { type: "text", text: "Second block." },
        ],
        "completed",
      ),
    ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(1);
    });

    useVoiceConversationStore.setState({ userSpeaking: true });

    await vi.waitFor(() => {
      expect(mocks.stopPocketVoice).toHaveBeenCalled();
      const content =
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content;
      expect(content?.[0]).toMatchObject({
        speech: { status: "interrupted" },
      });
      expect(content?.[2]).toMatchObject({
        speech: { status: "interrupted" },
      });
    });
    finishFirst?.();
    await Promise.resolve();
    expect(mocks.speakPocketVoice).toHaveBeenCalledTimes(1);
    expect(takeVoicePlaybackNotices("session-1")).toBe(
      "[voice: tts-delivery-failed]\n" +
        "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken.\n" +
        "Original text: First block.\n" +
        "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.\n" +
        "[voice: tts-delivery-failed]\n" +
        "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken.\n" +
        "Original text: Second block.\n" +
        "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.",
    );
  });

  it("marks active speech interrupted when voice conversation stops", async () => {
    mocks.speakPocketVoice.mockImplementation(() => new Promise(() => {}));
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Still speaking." }], "completed"),
      ]);
    await vi.waitFor(() => {
      expect(mocks.speakPocketVoice).toHaveBeenCalledWith("Still speaking.");
    });

    stopNativeAssistantSpeech();

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
    expect(takeVoicePlaybackNotices("session-1")).toBe(
      "[voice: tts-delivery-failed]\n" +
        "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken.\n" +
        "Original text: Still speaking.\n" +
        "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.",
    );
  });
});
