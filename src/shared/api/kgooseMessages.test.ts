import { afterAll, describe, expect, it, vi } from "vitest";
import {
  applyKgooseMessageDelta,
  asKgooseMessagesResponse,
  asKgooseStreamResponse,
} from "./kgooseMessages";

vi.stubGlobal("crypto", {
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("kgoose message helpers", () => {
  it("maps raw session message envelopes into timeline messages", () => {
    expect(
      asKgooseMessagesResponse({
        status: "CHAT_SESSION_STATUS_IDLE",
        session_name: "Daily revenue digest run",
        messages: [
          {
            id: "message-1",
            role: "ROLE_USER",
            created: "1714568300000",
            content: [
              {
                type: "MESSAGE_TYPE_TEXT",
                text: { text: "Run now" },
              },
            ],
          },
          {
            id: "message-2",
            role: "ROLE_ASSISTANT",
            created: "1714568400000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_REQUEST",
                tool_request: {
                  id: "tool-1",
                  status: "success",
                  value: {
                    name: "slack",
                    arguments: JSON.stringify({ channel: "revenue" }),
                  },
                },
              },
            ],
          },
          {
            id: "message-3",
            role: "ROLE_ASSISTANT",
            created: "1714568401000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_RESPONSE",
                tool_response: {
                  id: "tool-1",
                  status: "success",
                  extension_name: "slack",
                  results: [
                    {
                      text: {
                        text: "Fetched 3 Slack messages from #revenue.",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      sessionName: "Daily revenue digest run",
      status: "idle",
      messages: [
        expect.objectContaining({
          id: "message-1",
          role: "user",
          created: 1714568300000,
          content: [{ type: "text", text: "Run now" }],
        }),
        expect.objectContaining({
          id: "message-2",
          role: "assistant",
          created: 1714568400000,
          content: [
            expect.objectContaining({
              type: "toolRequest",
              id: "tool-1",
              name: "slack",
              arguments: { channel: "revenue" },
              status: "completed",
            }),
            expect.objectContaining({
              type: "toolResponse",
              id: "tool-1",
              name: "slack",
              result: "Fetched 3 Slack messages from #revenue.",
            }),
          ],
        }),
      ],
    });
  });

  it("normalizes stream snapshots and deltas", () => {
    const messages = asKgooseStreamResponse({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        messages: [
          {
            id: "message-1",
            role: "ROLE_ASSISTANT",
            created: "1714568400000",
            content: [
              {
                type: "MESSAGE_TYPE_TEXT",
                text: { text: "hello" },
              },
            ],
          },
        ],
      },
    });
    const delta = asKgooseStreamResponse({
      delta_message_content: {
        streaming_message_id: "message-2",
        message_content: {
          type: "MESSAGE_TYPE_TEXT",
          text: { text: "stream" },
        },
      },
    });

    expect(messages?.type).toBe("messages");
    expect(
      messages?.type === "messages" && messages.response.messages[0],
    ).toMatchObject({
      id: "message-1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(delta?.type).toBe("delta");
    expect(delta?.type === "delta" && delta.delta.streamingMessageId).toBe(
      "message-2",
    );
  });

  it("appends streaming text deltas into one assistant message", () => {
    const first = applyKgooseMessageDelta([], {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "hel" },
      },
    });
    const second = applyKgooseMessageDelta(first, {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "lo" },
      },
      isFinal: true,
    });

    expect(second).toHaveLength(1);
    expect(second[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(second[0].metadata?.completionStatus).toBe("completed");
  });
});
