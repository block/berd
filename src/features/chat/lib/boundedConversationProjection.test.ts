import { describe, expect, it } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import {
  HOME_CANVAS_RECENT_EXCHANGE_LIMIT,
  projectRecentConversationExchanges,
} from "./boundedConversationProjection";

function message(
  id: string,
  role: Message["role"],
  content: MessageContent[] = [{ type: "text", text: id }],
  metadata: Message["metadata"] = { userVisible: true },
): Message {
  return {
    id,
    role,
    created: Number(id.replace(/\D/g, "")) || 1,
    content,
    metadata,
  };
}

function exchange(
  index: number,
  assistantContent?: MessageContent[],
): Message[] {
  return [
    message(`user-${index}`, "user"),
    message(
      `assistant-${index}`,
      "assistant",
      assistantContent ?? [{ type: "text", text: `answer-${index}` }],
    ),
  ];
}

describe("projectRecentConversationExchanges", () => {
  it("selects exactly the 10 most recent complete user-led exchanges", () => {
    const source = Array.from({ length: 12 }, (_, index) =>
      exchange(index + 1),
    ).flat();

    const result = projectRecentConversationExchanges(source);

    expect(HOME_CANVAS_RECENT_EXCHANGE_LIMIT).toBe(10);
    expect(result.messages.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => [
        `user-${index + 3}`,
        `assistant-${index + 3}`,
      ]).flat(),
    );
    expect(result).toMatchObject({
      omittedExchangeCount: 2,
      hasOmittedExchanges: true,
      earliestVisibleMessageId: "user-3",
    });
  });

  it("keeps every event in a tool-heavy exchange without splitting it", () => {
    const toolHeavy: Message[] = [
      message("user-1", "user"),
      message("assistant-1a", "assistant", [
        { type: "thinking", text: "Planning" },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "delegate",
          arguments: { task: "Inspect" },
          status: "completed",
          subagentAgentName: "Rivet",
          subagentTaskLabel: "Inspect",
        },
      ]),
      message("assistant-1b", "assistant", [
        {
          type: "toolResponse",
          id: "tool-1",
          name: "delegate",
          result: "Artifact produced",
          isError: false,
        },
        { type: "image", data: "image", mimeType: "image/png" },
        { type: "text", text: "Finished" },
      ]),
      message("system-1", "system", [
        {
          type: "systemNotification",
          notificationType: "info",
          text: "Compacted",
        },
      ]),
    ];
    const source = [
      ...exchange(0),
      ...toolHeavy,
      ...Array.from({ length: 9 }, (_, index) => exchange(index + 2)).flat(),
    ];

    const result = projectRecentConversationExchanges(source);

    expect(result.messages.map(({ id }) => id)).toEqual([
      "user-1",
      "assistant-1a",
      "assistant-1b",
      "system-1",
      ...Array.from({ length: 9 }, (_, index) => [
        `user-${index + 2}`,
        `assistant-${index + 2}`,
      ]).flat(),
    ]);
  });

  it("preserves the complete current streaming exchange", () => {
    const streamingExchange = [
      message("user-11", "user"),
      message("assistant-11a", "assistant", [
        { type: "text", text: "Starting" },
        {
          type: "toolRequest",
          id: "live-tool",
          name: "work",
          arguments: {},
          status: "in_progress",
        },
      ]),
      message("assistant-11b", "assistant", [], {
        userVisible: true,
        completionStatus: "inProgress",
      }),
    ];
    const source = [
      ...Array.from({ length: 10 }, (_, index) => exchange(index + 1)).flat(),
      ...streamingExchange,
    ];

    expect(projectRecentConversationExchanges(source).messages).toEqual([
      ...Array.from({ length: 9 }, (_, index) => exchange(index + 2)).flat(),
      ...streamingExchange,
    ]);
  });

  it("keeps an assistant/system prelude when all exchanges fit", () => {
    const source = [
      message("system-prelude", "system"),
      message("assistant-prelude", "assistant"),
      ...exchange(1),
      ...exchange(2),
    ];

    const result = projectRecentConversationExchanges(source);

    expect(result.messages).toEqual(source);
    expect(result.earliestVisibleMessageId).toBe("system-prelude");
    expect(result.hasOmittedExchanges).toBe(false);
  });

  it("does not let invisible or assistant-only user events start exchanges", () => {
    const invisible = message(
      "hidden-user",
      "user",
      [{ type: "text", text: "control" }],
      {
        userVisible: false,
      },
    );
    const assistantOnly = message("assistant-only-user", "user", [
      {
        type: "text",
        text: "agent context",
        annotations: { audience: ["assistant"] },
      },
    ]);
    const source = [
      ...exchange(0),
      invisible,
      assistantOnly,
      ...Array.from({ length: 10 }, (_, index) => exchange(index + 1)).flat(),
    ];

    const result = projectRecentConversationExchanges(source);

    expect(result.omittedExchangeCount).toBe(1);
    expect(result.messages[0]?.id).toBe("user-1");
  });

  it("shows all messages when fewer than 10 exchanges exist", () => {
    const source = Array.from({ length: 4 }, (_, index) =>
      exchange(index + 1),
    ).flat();

    const result = projectRecentConversationExchanges(source);

    expect(result.messages).toEqual(source);
    expect(result).toMatchObject({
      omittedExchangeCount: 0,
      hasOmittedExchanges: false,
      earliestVisibleMessageId: "user-1",
    });
  });

  it("returns a new bounded array without mutating messages or source order", () => {
    const source = Array.from({ length: 12 }, (_, index) =>
      exchange(index + 1),
    ).flat();
    const snapshot = source.map(({ id }) => id);

    const result = projectRecentConversationExchanges(source);

    expect(source.map(({ id }) => id)).toEqual(snapshot);
    expect(result.messages).not.toBe(source);
    expect(result.messages[0]).toBe(source[4]);
  });
});
