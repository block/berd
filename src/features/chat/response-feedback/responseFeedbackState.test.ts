import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import { feedbackSurveySink } from "./feedbackSurveySink";
import {
  getResponseFeedbackSelection,
  isResponseFeedbackEligible,
  setResponseFeedbackSelection,
} from "./responseFeedbackState";

vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const sink = vi.mocked(feedbackSurveySink);

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "assistant-message",
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text: "Done" }],
    ...overrides,
  };
}

describe("responseFeedbackState", () => {
  beforeEach(() => {
    localStorage.clear();
    sink.mockClear();
  });

  it("emits selections, switches, and clears without duplicate transitions", () => {
    expect(
      setResponseFeedbackSelection("selection-session", "message", "good"),
    ).toBe("good");
    expect(
      setResponseFeedbackSelection("selection-session", "message", "good"),
    ).toBe("good");
    expect(
      setResponseFeedbackSelection("selection-session", "message", "bad"),
    ).toBe("bad");
    expect(
      setResponseFeedbackSelection("selection-session", "message", null),
    ).toBeNull();
    expect(
      getResponseFeedbackSelection("selection-session", "message"),
    ).toBeNull();

    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ eventType: "responded", response: "good" }),
      expect.objectContaining({ eventType: "responded", response: "bad" }),
      expect.objectContaining({ eventType: "responded", response: "cleared" }),
    ]);
  });

  it("only allows completed, user-visible assistant responses", () => {
    const visibleText: MessageContent[] = [{ type: "text", text: "Done" }];
    const eligible = (
      message: Message,
      content = visibleText,
      isStreaming = false,
    ) => isResponseFeedbackEligible({ message, content, isStreaming });

    expect(eligible(assistantMessage())).toBe(true);
    expect(
      eligible(assistantMessage(), [
        {
          type: "mcpApp",
          id: "mcp-app",
          payload: {
            sessionId: "session",
            toolCallId: "tool-call",
            toolCallTitle: "Interactive result",
            source: "toolCallUpdateMeta",
            tool: {
              name: "show_result",
              extensionName: "example",
              resourceUri: "ui://example/result",
            },
            resource: { result: null },
          },
        },
      ]),
    ).toBe(true);
    expect(eligible(assistantMessage(), visibleText, true)).toBe(false);
    expect(
      eligible(assistantMessage({ metadata: { completionStatus: "error" } })),
    ).toBe(false);
    expect(eligible({ ...assistantMessage(), role: "user" })).toBe(false);
    expect(eligible(assistantMessage(), [{ type: "text", text: "  " }])).toBe(
      false,
    );
    expect(
      eligible(assistantMessage(), [
        {
          type: "text",
          text: "internal",
          annotations: { audience: ["assistant"] },
        },
      ]),
    ).toBe(false);
  });
});
