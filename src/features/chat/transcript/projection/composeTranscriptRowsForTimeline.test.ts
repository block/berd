import { describe, expect, it } from "vitest";
import type { Message, MessageRole } from "@/shared/types/messages";
import type { TranscriptRowDescriptor } from "./transcriptItemTypes";
import { composeTranscriptRowsForTimeline } from "./composeTranscriptRowsForTimeline";

describe("composeTranscriptRowsForTimeline", () => {
  it("keeps one canonical row list and marks the preceding user turn", () => {
    const rows = [
      row("history"),
      row("date:today", { kind: "date-separator", messageId: undefined }),
      row("user-1"),
      row("assistant-1", { anchorPriority: "streaming" }),
    ];

    const composition = composeTranscriptRowsForTimeline({
      rows,
      messages: [
        message("user-1", "user"),
        message("assistant-1", "assistant"),
      ],
      streamingMessageId: "assistant-1",
    });

    expect(composition.rows).toBe(rows);
    expect(composition.rows).toEqual(rows);
    expect(composition.activeRange).toEqual({ start: 1, end: 4 });
    if (!composition.activeRange) throw new Error("expected active range");
    expect(composition.rows.slice(composition.activeRange.start)).toEqual([
      rows[1],
      rows[2],
      rows[3],
    ]);
  });

  it("starts at the assistant when the preceding message is not a user", () => {
    const rows = [
      row("date:today", { kind: "date-separator", messageId: undefined }),
      row("assistant-1", { anchorPriority: "streaming" }),
    ];

    const composition = composeTranscriptRowsForTimeline({
      rows,
      messages: [message("assistant-1", "assistant")],
      streamingMessageId: "assistant-1",
    });

    expect(composition.activeRange).toEqual({ start: 0, end: 2 });
  });

  it.each([
    ["without a stream id", null, [message("assistant-1", "assistant")]],
    [
      "when the stream is not an assistant",
      "user-1",
      [message("user-1", "user")],
    ],
    ["when the stream is missing", "assistant-1", []],
    [
      "when the preceding user has no row",
      "assistant-1",
      [message("user-1", "user"), message("assistant-1", "assistant")],
    ],
  ])("returns no active range %s", (_name, streamingMessageId, messages) => {
    const rows = [row("history"), row("assistant-1")];

    const composition = composeTranscriptRowsForTimeline({
      rows,
      messages,
      streamingMessageId,
    });

    expect(composition.rows).toBe(rows);
    expect(composition.activeRange).toBeNull();
  });
});

function message(id: string, role: MessageRole): Message {
  return {
    id,
    role,
    created: 1,
    content: [{ type: "text", text: id }],
  };
}

function row(
  rowId: string,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId,
    renderRevision: `render:${rowId}`,
    heightRevision: `height:${rowId}`,
    layoutRevision: "layout-spacing:0",
    estimatedHeight: 80,
    spacingBefore: 0,
    anchorPriority: "stable",
    measurementPolicy: "measure-real",
    layoutPendingPolicy: "can-finalize",
    capabilities: {
      stateful: false,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: "none",
    ...overrides,
  };
}
