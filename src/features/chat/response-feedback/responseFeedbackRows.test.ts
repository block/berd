import { describe, expect, it } from "vitest";
import { selectResponseFeedbackRowIds } from "./responseFeedbackRows";

describe("selectResponseFeedbackRowIds", () => {
  it("prefers the answer over companion rows", () => {
    expect([
      ...selectResponseFeedbackRowIds([
        {
          kind: "message",
          rowId: "message:assistant:companion-image",
          messageId: "assistant",
          responseStartMessageId: "assistant",
        },
        {
          kind: "message",
          rowId: "message:assistant:answer",
          messageId: "assistant",
          responseStartMessageId: "assistant",
        },
        {
          kind: "message",
          rowId: "message:assistant:companion-mcp-app",
          messageId: "assistant",
          responseStartMessageId: "assistant",
        },
      ]),
    ]).toEqual(["message:assistant:answer"]);
  });

  it("uses one final host row when there is no answer row", () => {
    expect([
      ...selectResponseFeedbackRowIds([
        {
          kind: "assistant-content-fragment",
          rowId: "message:assistant:fragment-0",
          messageId: "assistant",
        },
        {
          kind: "assistant-content-fragment",
          rowId: "message:assistant:fragment-1",
          messageId: "assistant",
        },
      ]),
    ]).toEqual(["message:assistant:fragment-1"]);
  });
});
