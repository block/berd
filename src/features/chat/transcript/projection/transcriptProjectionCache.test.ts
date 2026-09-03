import { describe, expect, it } from "vitest";
import type {
  McpAppContent,
  Message,
  MessageContent,
  MessageMetadata,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";
import { buildMessageRevisions } from "./messageRevisions";
import { createTranscriptProjectionCache } from "./transcriptProjectionCache";
import type {
  TranscriptProjectionSnapshot,
  TranscriptRowDescriptor,
} from "./transcriptItemTypes";

const SESSION_ID = "session-1";
const NOW_BUCKET = "2026-06-04";
const LOCALE_KEY = "en-US";

describe("transcript projection cache", () => {
  it("preserves descriptor identity for equivalent message updates", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "hello", utc(2026, 6, 4, 10)),
      message("assistant-1", "assistant", "hi", utc(2026, 6, 4, 10, 1)),
    ];

    const first = update(cache, messages);
    const second = update(
      cache,
      messages.map((item) => ({
        ...item,
        content: [...item.content],
      })),
    );

    expect(first.descriptorChurn).toBe(0);
    expect(first.changedRowIds.size).toBe(first.rows.length);
    expect(second.descriptorChurn).toBe(0);
    expect([...second.changedRowIds]).toEqual([]);
    expect(second.reusedPrefixCount).toBe(first.rows.length);
    expect(second.reusedSuffixCount).toBe(first.rows.length);
    expect(second.rows).toHaveLength(first.rows.length);
    expect(second.rows[0]).toBe(first.rows[0]);
    expect(second.rows[1]).toBe(first.rows[1]);
    expect(second.rows[2]).toBe(first.rows[2]);
  });

  it("keeps prefix descriptors and stable row keys across streaming updates", () => {
    const cache = createTranscriptProjectionCache();
    const user = message("user-1", "user", "prompt", utc(2026, 6, 4, 10));
    const assistant = message(
      "assistant-1",
      "assistant",
      "hel",
      utc(2026, 6, 4, 10, 1),
      { completionStatus: "inProgress" },
    );

    const first = update(cache, [user, assistant], "assistant-1");
    const assistantBefore = messageRow(first, "assistant-1");
    const second = update(
      cache,
      [user, { ...assistant, content: [{ type: "text", text: "hello" }] }],
      "assistant-1",
    );
    const assistantAfter = messageRow(second, "assistant-1");

    expect(second.reusedPrefixCount).toBe(2);
    expect(second.rows[0]).toBe(first.rows[0]);
    expect(second.rows[1]).toBe(first.rows[1]);
    expect(assistantAfter).not.toBe(assistantBefore);
    expect(assistantAfter.rowId).toBe(assistantBefore.rowId);
    expect(assistantAfter.reactKey).toBe(assistantBefore.reactKey);
    expect(assistantAfter.renderRevision).not.toBe(
      assistantBefore.renderRevision,
    );
    expect(assistantAfter.heightRevision).not.toBe(
      assistantBefore.heightRevision,
    );
    expect(assistantAfter.anchorPriority).toBe("streaming");
    expect(assistantAfter.rowId).toBe("message:assistant-1");
    expect(assistantAfter.kind).toBe("message");
    expect([...second.changedRowIds]).toEqual(["message:assistant-1"]);
  });

  it("splits eligible completed assistant text into stable fragment rows", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-fragmented",
      "assistant",
      multiParagraphText("completed fragment", 3, 20),
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const fragmentRows = snapshot.rows.filter(
      (row) => row.kind === "assistant-content-fragment",
    );

    expect(fragmentRows.map((row) => row.rowId)).toEqual([
      "message:assistant-fragmented:block-0",
      "message:assistant-fragmented:block-1",
      "message:assistant-fragmented:block-2",
    ]);
    expect(fragmentRows.map((row) => row.fragment?.role)).toEqual([
      "start",
      "middle",
      "end",
    ]);
    expect(fragmentRows.every((row) => row.anchorPriority === "stable")).toBe(
      true,
    );
    expect(snapshot.fragmentRowCount).toBe(3);
    expect(snapshot.completedFragmentRowCount).toBe(3);
    expect(snapshot.streamingTailRowCount).toBe(0);
    expect(snapshot.rowByMessageId.get("assistant-fragmented")).toBe(
      "message:assistant-fragmented:block-0",
    );
    expect(snapshot.searchableTextByMessageId.get("assistant-fragmented")).toBe(
      assistant.content[0]?.type === "text" ? assistant.content[0].text : "",
    );
  });

  it("keeps long markdown tables on whole-message rows", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-table",
      "assistant",
      longMarkdownTable("table row", 76),
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-table");

    expect(row.kind).toBe("message");
    expect(row.rowId).toBe("message:assistant-table");
    expect(snapshot.fragmentRowCount).toBe(0);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(1);
  });

  it("keeps a standalone code block as a single fragment row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-tilde-fence",
      "assistant",
      longTildeCodeBlock(76),
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-tilde-fence");

    expect(row.kind).toBe("message");
    expect(snapshot.fragmentRowCount).toBe(0);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(1);
  });

  it("fragments a message with a code block and surrounding text", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-with-code",
      "assistant",
      textWithCodeBlock(20),
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const fragmentRows = snapshot.rows.filter(
      (row) => row.kind === "assistant-content-fragment",
    );

    expect(fragmentRows.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.fragmentRowCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(0);
    expect(fragmentRows[0]?.fragment?.role).toBe("start");
    expect(fragmentRows[fragmentRows.length - 1]?.fragment?.role).toBe("end");
    expect(snapshot.rowByMessageId.get("assistant-with-code")).toBe(
      "message:assistant-with-code:block-0",
    );
  });

  it("keeps short messages with code blocks on whole-message rows", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-short-code",
      "assistant",
      "intro\n```typescript\nconst x = 1;\n```\noutro",
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-short-code");

    expect(row.kind).toBe("message");
    expect(snapshot.fragmentRowCount).toBe(0);
  });

  it("keeps long active streaming assistant text on one mutable row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-streaming",
      "assistant",
      longText("streaming fragment", 88),
      utc(2026, 6, 4, 10),
      { completionStatus: "inProgress" },
    );

    const first = update(cache, [assistant], "assistant-streaming");
    const rowBefore = messageRow(first, "assistant-streaming");
    const second = update(
      cache,
      [
        {
          ...assistant,
          content: [
            {
              type: "text",
              text: `${(assistant.content[0] as { text: string }).text}\nstreaming appended line`,
            },
          ],
        },
      ],
      "assistant-streaming",
    );
    const rowAfter = messageRow(second, "assistant-streaming");

    expect(first.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-streaming",
      "message:assistant-streaming",
    ]);
    expect(rowBefore.kind).toBe("message");
    expect(rowAfter.kind).toBe("message");
    expect(rowAfter).not.toBe(rowBefore);
    expect(rowAfter.rowId).toBe(rowBefore.rowId);
    expect(rowAfter.reactKey).toBe(rowBefore.reactKey);
    expect(rowAfter.anchorPriority).toBe("streaming");
    expect(rowAfter.heightRevision).not.toBe(rowBefore.heightRevision);
    expect(first.fragmentRowCount).toBe(0);
    expect(second.fragmentRowCount).toBe(0);
    expect(second.completedStreamingFragmentRowCount).toBe(0);
    expect(second.streamingTailRowCount).toBe(0);
    expect(second.wholeMessageFallbackRowCount).toBe(1);
    expect(second.rowByMessageId.get("assistant-streaming")).toBe(
      "message:assistant-streaming",
    );
    expect([...second.changedRowIds]).toEqual(["message:assistant-streaming"]);
  });

  it("keeps active streaming markdown tables on the whole mutable row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-streaming-table",
      "assistant",
      longMarkdownTable("streaming table row", 76),
      utc(2026, 6, 4, 10),
      { completionStatus: "inProgress" },
    );

    const snapshot = update(cache, [assistant], "assistant-streaming-table");
    const row = messageRow(snapshot, "assistant-streaming-table");

    expect(row.kind).toBe("message");
    expect(row.rowId).toBe("message:assistant-streaming-table");
    expect(row.anchorPriority).toBe("streaming");
    expect(snapshot.fragmentRowCount).toBe(0);
    expect(snapshot.streamingTailRowCount).toBe(0);
    expect(snapshot.completedStreamingFragmentRowCount).toBe(0);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(1);
  });

  it("fragments a long response after active streaming is cancelled", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-cancelled",
      "assistant",
      multiParagraphText("cancelled streaming fragment", 3, 20),
      utc(2026, 6, 4, 10),
      { completionStatus: "inProgress" },
    );

    const active = update(cache, [assistant], "assistant-cancelled");
    const activeRow = messageRow(active, "assistant-cancelled");

    const cancelling = update(cache, [assistant], null);
    const cancellingCompletedFragment = rowById(
      cancelling,
      "message:assistant-cancelled:stream-block-0",
    );
    const cancellingTail = rowById(
      cancelling,
      "message:assistant-cancelled:stream-tail",
    );

    expect(active.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-cancelled",
      "message:assistant-cancelled",
    ]);
    expect(activeRow.kind).toBe("message");
    expect(activeRow.anchorPriority).toBe("streaming");
    expect(active.fragmentRowCount).toBe(0);
    expect(active.completedStreamingFragmentRowCount).toBe(0);
    expect(active.streamingTailRowCount).toBe(0);
    expect(active.wholeMessageFallbackRowCount).toBe(1);
    expect(cancelling.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-cancelled",
      "message:assistant-cancelled:stream-block-0",
      "message:assistant-cancelled:stream-block-1",
      "message:assistant-cancelled:stream-tail",
    ]);
    expect(cancellingCompletedFragment.anchorPriority).toBe("stable");
    expect(cancellingCompletedFragment.fragment?.isStreamingTail).toBe(false);
    expect(cancellingTail.anchorPriority).toBe("stable");
    expect(cancellingTail.fragment?.isStreamingTail).toBe(false);
    expect(cancelling.streamingTailRowCount).toBe(0);
    expect(cancelling.completedStreamingFragmentRowCount).toBe(2);
    expect(cancelling.rowByMessageId.get("assistant-cancelled")).toBe(
      "message:assistant-cancelled:stream-block-0",
    );
    expect([...cancelling.changedRowIds]).toEqual([
      "message:assistant-cancelled:stream-block-0",
      "message:assistant-cancelled:stream-block-1",
      "message:assistant-cancelled:stream-tail",
      "message:assistant-cancelled",
    ]);

    const stopped = update(
      cache,
      [
        {
          ...assistant,
          metadata: {
            ...assistant.metadata,
            completionStatus: "stopped",
          },
        },
      ],
      null,
    );

    expect(stopped.rows.map((row) => row.rowId)).toEqual(
      cancelling.rows.map((row) => row.rowId),
    );
    expect(rowById(stopped, "message:assistant-cancelled:stream-tail")).toBe(
      cancellingTail,
    );
    expect([...stopped.changedRowIds]).toEqual([]);
  });

  it("keeps historical completed assistant text on completed fragment row keys", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = message(
      "assistant-completed",
      "assistant",
      multiParagraphText("completed fragment", 3, 20),
      utc(2026, 6, 4, 10),
      { completionStatus: "completed" },
    );

    const snapshot = update(cache, [assistant]);
    const fragmentRows = snapshot.rows.filter(
      (row) => row.kind === "assistant-content-fragment",
    );

    expect(fragmentRows.map((row) => row.rowId)).toEqual([
      "message:assistant-completed:block-0",
      "message:assistant-completed:block-1",
      "message:assistant-completed:block-2",
    ]);
    expect(snapshot.streamingTailRowCount).toBe(0);
    expect(snapshot.completedStreamingFragmentRowCount).toBe(0);
  });

  it("projects reasoning and tools into an ordered agent work row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-reasoning-tools",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the files first." },
        toolRequest("tool-1"),
        { type: "thinking", text: "Now I should compare the results." },
        toolRequest("tool-2"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-reasoning-tools",
      "message:assistant-reasoning-tools:agent-work",
    ]);
    const workRow = rowById(
      snapshot,
      "message:assistant-reasoning-tools:agent-work",
    );
    expect(workRow.kind).toBe("agent-work");
    expect(workRow.agentWork?.thoughtCount).toBe(2);
    expect(workRow.agentWork?.toolCount).toBe(2);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(0);
  });

  it("places trailing reasoning before the final answer", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-trailing-reasoning",
      "assistant",
      [
        { type: "text", text: "Here is the final answer." },
        {
          type: "thinking",
          text: "I should summarize the recommendation for the user.",
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-trailing-reasoning",
      "message:assistant-trailing-reasoning:agent-work",
      "message:assistant-trailing-reasoning:answer",
    ]);
    expect(
      rowById(snapshot, "message:assistant-trailing-reasoning:agent-work")
        .agentWork?.hasFinalAnswer,
    ).toBe(true);
  });

  it("keeps the final answer before an earlier companion", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-companion-trailing-reasoning",
      "assistant",
      [
        { type: "text", text: "Here is the final answer." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        { type: "thinking", text: "I should inspect the preview." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-companion-trailing-reasoning",
      "message:assistant-companion-trailing-reasoning:agent-work",
      "message:assistant-companion-trailing-reasoning:answer",
      expect.stringMatching(
        /^message:assistant-companion-trailing-reasoning:companion-image-/,
      ),
    ]);
  });

  it("keeps a later companion after the final answer", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-trailing-reasoning-companion",
      "assistant",
      [
        { type: "text", text: "Here is the final answer." },
        { type: "thinking", text: "I should inspect the preview." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-trailing-reasoning-companion",
      "message:assistant-trailing-reasoning-companion:agent-work",
      "message:assistant-trailing-reasoning-companion:answer",
      expect.stringMatching(
        /^message:assistant-trailing-reasoning-companion:companion-image-/,
      ),
    ]);
  });

  it("keeps trailing reasoning inside active work until settling", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-streaming-trailing-reasoning",
      "assistant",
      [
        { type: "text", text: "Here is the final answer." },
        { type: "thinking", text: "I should summarize the result." },
      ],
      utc(2026, 6, 4, 10),
      { completionStatus: "inProgress" },
    );

    const streaming = update(cache, [assistant], assistant.id);
    expect(streaming.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-streaming-trailing-reasoning",
      "message:assistant-streaming-trailing-reasoning:agent-work",
    ]);

    const completed = update(cache, [
      {
        ...assistant,
        metadata: { ...assistant.metadata, completionStatus: "completed" },
      },
    ]);
    expect(completed.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-streaming-trailing-reasoning",
      "message:assistant-streaming-trailing-reasoning:agent-work",
      "message:assistant-streaming-trailing-reasoning:answer",
    ]);
  });

  it("keeps multiple trailing work groups in order before the final answer", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-multi-trailing-work",
      "assistant",
      [
        { type: "text", text: "Here is the final answer." },
        { type: "thinking", text: "I should double-check the preview." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        { type: "thinking", text: "I should summarize the recommendation." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-multi-trailing-work",
      "message:assistant-multi-trailing-work:agent-work-0",
      "message:assistant-multi-trailing-work:agent-work-1",
      "message:assistant-multi-trailing-work:answer",
      expect.stringMatching(
        /^message:assistant-multi-trailing-work:companion-image-/,
      ),
    ]);
    expect(
      rowById(snapshot, "message:assistant-multi-trailing-work:agent-work-0")
        .agentWork?.content,
    ).toContainEqual({
      type: "thinking",
      text: "I should double-check the preview.",
    });
    expect(
      rowById(snapshot, "message:assistant-multi-trailing-work:agent-work-1")
        .agentWork?.content,
    ).toContainEqual({
      type: "thinking",
      text: "I should summarize the recommendation.",
    });
  });

  it("places leading and trailing work before the final answer", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-leading-and-trailing-work",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the files." },
        toolRequest("tool-1"),
        { type: "text", text: "Here is the final answer." },
        { type: "thinking", text: "I should summarize the result." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-leading-and-trailing-work",
      "message:assistant-leading-and-trailing-work:agent-work-0",
      "message:assistant-leading-and-trailing-work:agent-work-1",
      "message:assistant-leading-and-trailing-work:answer",
    ]);
    expect(
      rowById(
        snapshot,
        "message:assistant-leading-and-trailing-work:agent-work-0",
      ).agentWork?.hasFinalAnswer,
    ).toBe(false);
    expect(
      rowById(
        snapshot,
        "message:assistant-leading-and-trailing-work:agent-work-1",
      ).agentWork?.hasFinalAnswer,
    ).toBe(true);
  });

  it("dedupes adjacent duplicate reasoning-only assistant messages", () => {
    const cache = createTranscriptProjectionCache();
    const firstThought = messageWithContent(
      "assistant-thought-1",
      "assistant",
      [{ type: "thinking", text: "I should inspect the files first." }],
      utc(2026, 6, 4, 10),
    );
    const duplicateThought = messageWithContent(
      "assistant-thought-2",
      "assistant",
      [{ type: "thinking", text: "I should inspect the files first." }],
      utc(2026, 6, 4, 10) + 1,
    );
    const nextThought = messageWithContent(
      "assistant-thought-3",
      "assistant",
      [{ type: "thinking", text: "Now I should compare the results." }],
      utc(2026, 6, 4, 10) + 2,
    );

    const snapshot = update(cache, [
      firstThought,
      duplicateThought,
      nextThought,
    ]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-thought-1",
      "message:assistant-thought-1:agent-work",
      "message:assistant-thought-3:agent-work",
    ]);
  });

  it("removes duplicated provider-context reasoning from following tool rows", () => {
    const cache = createTranscriptProjectionCache();
    const displayedThought = messageWithContent(
      "assistant-thought-display",
      "assistant",
      [{ type: "thinking", text: "I should inspect the files first." }],
      utc(2026, 6, 4, 10),
    );
    const toolWithProviderContextThought = messageWithContent(
      "assistant-tool-with-provider-thought",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the files first." },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10) + 1,
    );

    const snapshot = update(cache, [
      displayedThought,
      toolWithProviderContextThought,
    ]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-thought-display",
      "message:assistant-thought-display:agent-work",
      "message:assistant-tool-with-provider-thought:agent-work",
    ]);
    const toolWork = rowById(
      snapshot,
      "message:assistant-tool-with-provider-thought:agent-work",
    );
    expect(toolWork.agentWork?.thoughtCount).toBe(0);
    expect(toolWork.agentWork?.toolCount).toBe(1);
  });

  it("dedupes repeated leading reasoning across tool responses", () => {
    const cache = createTranscriptProjectionCache();
    const thought = "I should inspect branches before deleting anything.";
    const firstTool = messageWithContent(
      "assistant-first-tool-with-thought",
      "assistant",
      [{ type: "thinking", text: thought }, toolRequest("tool-1")],
      utc(2026, 6, 4, 10),
    );
    const firstToolResponse = messageWithContent(
      "tool-response-1",
      "user",
      [toolResponse("tool-1")],
      utc(2026, 6, 4, 10) + 1,
    );
    const secondTool = messageWithContent(
      "assistant-second-tool-with-duplicate-thought",
      "assistant",
      [{ type: "thinking", text: thought }, toolRequest("tool-2")],
      utc(2026, 6, 4, 10) + 2,
    );

    const snapshot = update(cache, [firstTool, firstToolResponse, secondTool]);
    const firstWork = rowById(
      snapshot,
      "message:assistant-first-tool-with-thought:agent-work",
    );
    const secondWork = rowById(
      snapshot,
      "message:assistant-second-tool-with-duplicate-thought:agent-work",
    );

    expect(firstWork.agentWork?.thoughtCount).toBe(1);
    expect(firstWork.agentWork?.toolCount).toBe(1);
    expect(secondWork.agentWork?.thoughtCount).toBe(0);
    expect(secondWork.agentWork?.toolCount).toBe(1);
  });

  it("dedupes repeated reasoning inside one work message across tool calls", () => {
    const cache = createTranscriptProjectionCache();
    const thought =
      "I should inspect branches before deleting anything because this is destructive and I need to gather current branch status first.";
    const assistant = messageWithContent(
      "assistant-one-message-repeated-thought-around-tools",
      "assistant",
      [
        { type: "thinking", text: thought },
        toolRequest("tool-1"),
        { type: "thinking", text: thought },
        toolRequest("tool-2"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-one-message-repeated-thought-around-tools:agent-work",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(1);
    expect(workRow.agentWork?.toolCount).toBe(2);
    expect(
      workRow.agentWork?.content.filter(
        (content) => content.type === "thinking",
      ),
    ).toHaveLength(1);
  });

  it("collapses repeated reasoning inside a single work message", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-duplicated-thinking-block",
      "assistant",
      [
        {
          type: "thinking",
          text: [
            "**Resolving conflicts in tests**",
            "",
            "I need to resolve conflicts by including both the HEAD new tests and our own. I should remove any markers that are causing confusion. Maybe I'll use Python to replace the conflict block with both the HEAD block and ours. It's important to be precise about the changes I make. It sounds straightforward, but I want to ensure everything is done correctly and nothing gets overlooked!Resolving conflicts in tests",
            "",
            "I need to resolve conflicts by including both the HEAD new tests and our own. I should remove any markers that are causing confusion. Maybe I'll use Python to replace the conflict block with both the HEAD block and ours. It's important to be precise about the changes I make. It sounds straightforward, but I want to ensure everything is done correctly and nothing gets overlooked!",
          ].join("\n"),
        },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-duplicated-thinking-block:agent-work",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(1);
    const thought = workRow.agentWork?.content.find(
      (content) => content.type === "thinking",
    );
    expect(thought?.text).toContain("**Resolving conflicts in tests**");
    expect(thought?.text.match(/I need to resolve conflicts/g)).toHaveLength(1);
    expect(thought?.text).not.toContain(
      "overlooked!Resolving conflicts in tests",
    );
  });

  it("splits titled reasoning sections inside one work message", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-multi-section-thinking",
      "assistant",
      [
        {
          type: "thinking",
          text: [
            "**Inspecting code issues**",
            "",
            "I need to address the first issue before editing.",
            "**Refining URL handling**",
            "",
            "I should consider how URL handling behaves without a secret.",
            "**Considering URL manipulation**",
            "",
            "I can use the URL crate to adjust query pairs safely.",
          ].join("\n"),
        },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-multi-section-thinking:agent-work",
    );
    const thoughts = workRow.agentWork?.content.filter(
      (content) => content.type === "thinking",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(3);
    expect(thoughts).toHaveLength(3);
    expect(thoughts?.map((thought) => thought.text)).toEqual([
      "**Inspecting code issues**\n\nI need to address the first issue before editing.",
      "**Refining URL handling**\n\nI should consider how URL handling behaves without a secret.",
      "**Considering URL manipulation**\n\nI can use the URL crate to adjust query pairs safely.",
    ]);
  });

  it("does not split inline bold inside reasoning text", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-inline-bold-thinking",
      "assistant",
      [
        {
          type: "thinking",
          text: "I should inspect **get_goose_serve_url** before editing the helper.",
        },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-inline-bold-thinking:agent-work",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(1);
    expect(
      workRow.agentWork?.content.filter(
        (content) => content.type === "thinking",
      ),
    ).toHaveLength(1);
  });

  it("dedupes a later thought that first appeared as a section", () => {
    const cache = createTranscriptProjectionCache();
    const firstThought = messageWithContent(
      "assistant-combined-sections",
      "assistant",
      [
        {
          type: "thinking",
          text: [
            "**Evaluating PR process**",
            "",
            "I need to figure out how to respond since the user wants to create a PR.",
            "**Committing changes for PR**",
            "",
            "I’m thinking about how to proceed with the user’s request for a PR.",
          ].join("\n"),
        },
      ],
      utc(2026, 6, 4, 10),
    );
    const repeatedSectionWithTool = messageWithContent(
      "assistant-repeated-section-with-tool",
      "assistant",
      [
        {
          type: "thinking",
          text: [
            "**Committing changes for PR**",
            "",
            "I’m thinking about how to proceed with the user’s request for a PR.",
          ].join("\n"),
        },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10) + 1,
    );

    const snapshot = update(cache, [firstThought, repeatedSectionWithTool]);
    const firstWork = rowById(
      snapshot,
      "message:assistant-combined-sections:agent-work",
    );
    const secondWork = rowById(
      snapshot,
      "message:assistant-repeated-section-with-tool:agent-work",
    );

    expect(firstWork.agentWork?.thoughtCount).toBe(2);
    expect(secondWork.agentWork?.thoughtCount).toBe(0);
    expect(secondWork.agentWork?.toolCount).toBe(1);
  });

  it("dedupes repeated titled reasoning sections after splitting", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-repeated-section-thinking",
      "assistant",
      [
        {
          type: "thinking",
          text: [
            "**Inspecting code issues**",
            "",
            "I need to address the first issue before editing.",
            "**Refining URL handling**",
            "",
            "I should consider how URL handling behaves without a secret.",
          ].join("\n"),
        },
        toolRequest("tool-1"),
        {
          type: "thinking",
          text: [
            "**Refining URL handling**",
            "",
            "I should consider how URL handling behaves without a secret.",
          ].join("\n"),
        },
        toolRequest("tool-2"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-repeated-section-thinking:agent-work",
    );
    const thoughts = workRow.agentWork?.content.filter(
      (content) => content.type === "thinking",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(2);
    expect(workRow.agentWork?.toolCount).toBe(2);
    expect(thoughts?.map((thought) => thought.text)).toEqual([
      "**Inspecting code issues**\n\nI need to address the first issue before editing.",
      "**Refining URL handling**\n\nI should consider how URL handling behaves without a secret.",
    ]);
  });

  it("dedupes adjacent reasoning when one copy has a glued title", () => {
    const cache = createTranscriptProjectionCache();
    const thought =
      "I need to resolve conflicts by including both the HEAD new tests and our own. I should remove any markers that are causing confusion. Maybe I'll use Python to replace the conflict block with both the HEAD block and ours. It's important to be precise about the changes I make. It sounds straightforward, but I want to ensure everything is done correctly and nothing gets overlooked!";
    const assistant = messageWithContent(
      "assistant-adjacent-glued-title-thinking",
      "assistant",
      [
        {
          type: "thinking",
          text: `**Resolving conflicts in tests**\n\n${thought}Resolving conflicts in tests`,
        },
        { type: "thinking", text: thought },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-adjacent-glued-title-thinking:agent-work",
    );

    expect(workRow.agentWork?.thoughtCount).toBe(1);
    const thinkingBlocks = workRow.agentWork?.content.filter(
      (content) => content.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks?.[0]?.text).not.toContain(
      "overlooked!Resolving conflicts in tests",
    );
  });

  it("keeps agent work projected when a completed turn also contains an image", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-work-with-image",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the rendered result." },
        toolRequest("tool-1"),
        { type: "text", text: "The implementation is complete." },
        {
          type: "image",
          data: "c2NyZWVuc2hvdA==",
          mimeType: "image/png",
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-work-with-image",
      "message:assistant-work-with-image:agent-work",
      "message:assistant-work-with-image:answer",
      expect.stringMatching(
        /^message:assistant-work-with-image:companion-image-/,
      ),
    ]);
    expect(
      rowById(snapshot, "message:assistant-work-with-image:agent-work").kind,
    ).toBe("agent-work");
    expect(
      rowById(snapshot, "message:assistant-work-with-image:answer").kind,
    ).toBe("message");
    expect(
      snapshot.rows.find((row) =>
        row.rowId.startsWith(
          "message:assistant-work-with-image:companion-image-",
        ),
      )?.kind,
    ).toBe("message");
  });

  it("keeps agent work projected when a turn also contains MCP app content", () => {
    const cache = createTranscriptProjectionCache();
    const mcpApp: McpAppContent = {
      type: "mcpApp",
      id: "mcp-app-1",
      payload: {
        sessionId: "mcp-session-1",
        toolCallId: "tool-1",
        toolCallTitle: "Preview",
        source: "toolCallUpdateMeta",
        tool: {
          name: "preview",
          extensionName: "mcp",
          resourceUri: "ui://preview",
        },
        resource: { result: null },
      },
    };
    const assistant = messageWithContent(
      "assistant-work-with-mcp",
      "assistant",
      [
        { type: "thinking", text: "I should open the interactive preview." },
        toolRequest("tool-1"),
        mcpApp,
        { type: "text", text: "The preview is ready." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-work-with-mcp",
      "message:assistant-work-with-mcp:agent-work",
      "message:assistant-work-with-mcp:companion-mcpApp-mcp-app-1",
      "message:assistant-work-with-mcp:answer",
    ]);
    expect(
      rowById(snapshot, "message:assistant-work-with-mcp:agent-work").kind,
    ).toBe("agent-work");
    expect(
      rowById(
        snapshot,
        "message:assistant-work-with-mcp:companion-mcpApp-mcp-app-1",
      ).responseStartMessageId,
    ).toBe("assistant-work-with-mcp");
  });

  it("keeps leading progress before a companion in agent work order", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-leading-progress",
      "assistant",
      [
        { type: "text", text: "I’m preparing the preview." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        toolRequest("tool-1"),
        { type: "text", text: "The preview is ready." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.kind)).toEqual([
      "date-separator",
      "agent-work",
      "message",
      "agent-work",
      "message",
    ]);
    const workRow = rowById(
      snapshot,
      "message:assistant-leading-progress:agent-work-0",
    );
    expect(workRow.agentWork?.content).toContainEqual({
      type: "text",
      text: "I’m preparing the preview.",
    });
  });

  it("preserves work and companion source order", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-interleaved-companion",
      "assistant",
      [
        toolRequest("tool-1"),
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        toolRequest("tool-2"),
        { type: "text", text: "Here is the final answer." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-interleaved-companion",
      "message:assistant-interleaved-companion:agent-work-0",
      expect.stringMatching(
        /^message:assistant-interleaved-companion:companion-image-/,
      ),
      "message:assistant-interleaved-companion:agent-work-1",
      "message:assistant-interleaved-companion:answer",
    ]);
  });

  it("does not merge final-answer text across a companion boundary", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-split-answer",
      "assistant",
      [
        toolRequest("tool-1"),
        { type: "text", text: "The first result is ready." },
        { type: "image", data: "cHJldmlldw==", mimeType: "image/png" },
        { type: "text", text: "Here is the final answer." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const workRow = rowById(
      snapshot,
      "message:assistant-split-answer:agent-work",
    );

    expect(snapshot.rows.map((row) => row.kind)).toEqual([
      "date-separator",
      "agent-work",
      "message",
      "message",
    ]);
    expect(workRow.agentWork?.content).toContainEqual({
      type: "text",
      text: "The first result is ready.",
    });
    const answer = snapshot.items.find(
      (item) => item.itemId === "message:assistant-split-answer:answer",
    );
    expect(answer?.kind).toBe("message");
    if (answer?.kind === "message") {
      expect(answer.visibleContent).toEqual([
        { type: "text", text: "Here is the final answer." },
      ]);
    }
  });

  it("preserves speech state across agent-work and final-answer projection", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-voice-work",
      "assistant",
      [
        {
          type: "text",
          text: "First spoken block.",
          speech: { status: "spoken" },
        },
        toolRequest("tool-1"),
        {
          type: "thinking",
          text: "Considering the result.",
        },
        {
          type: "text",
          text: "Final speaking block.",
          speech: { status: "speaking" },
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const work = snapshot.items.find(
      (item) => item.itemId === "message:assistant-voice-work:agent-work",
    );
    const answer = snapshot.items.find(
      (item) => item.itemId === "message:assistant-voice-work:answer",
    );

    expect(work?.kind).toBe("agent-work");
    if (work?.kind === "agent-work") {
      expect(work.content).toContainEqual({
        type: "text",
        text: "First spoken block.",
        speech: { status: "spoken" },
      });
    }
    expect(answer?.kind).toBe("message");
    if (answer?.kind === "message") {
      expect(answer.visibleContent).toEqual([
        {
          type: "text",
          text: "Final speaking block.",
          speech: { status: "speaking" },
        },
      ]);
    }
  });

  it("keeps adjacent final text with different speech states separate", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-voice-segments",
      "assistant",
      [
        { type: "thinking", text: "Preparing two segments." },
        {
          type: "text",
          text: "Already spoken.",
          speech: { status: "spoken" },
        },
        {
          type: "text",
          text: "Speaking now.",
          speech: { status: "speaking" },
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const answer = snapshot.items.find(
      (item) => item.itemId === "message:assistant-voice-segments:answer",
    );

    expect(answer?.kind).toBe("message");
    if (answer?.kind === "message") {
      expect(answer.visibleContent).toEqual([
        {
          type: "text",
          text: "Already spoken.",
          speech: { status: "spoken" },
        },
        {
          type: "text",
          text: "Speaking now.",
          speech: { status: "speaking" },
        },
      ]);
    }
  });

  it("keeps an MCP companion row identity stable when another app is inserted", () => {
    const cache = createTranscriptProjectionCache();
    const mcpApp = (id: string): McpAppContent => ({
      type: "mcpApp",
      id,
      payload: {
        sessionId: "mcp-session-1",
        toolCallId: "tool-1",
        toolCallTitle: "Preview",
        source: "toolCallUpdateMeta",
        tool: {
          name: "preview",
          extensionName: "mcp",
          resourceUri: `ui://${id}`,
        },
        resource: { result: null },
      },
    });
    const baseContent: MessageContent[] = [
      { type: "thinking", text: "I should inspect both previews." },
      toolRequest("tool-1"),
      mcpApp("first-app"),
      mcpApp("second-app"),
    ];
    const first = update(cache, [
      messageWithContent(
        "assistant-stable-companions",
        "assistant",
        baseContent,
        utc(2026, 6, 4, 10),
      ),
    ]);
    const secondAppRowId = first.rows.find((row) =>
      row.rowId.includes("companion-mcpApp-second-app"),
    )?.rowId;

    const second = update(cache, [
      messageWithContent(
        "assistant-stable-companions",
        "assistant",
        [...baseContent.slice(0, 3), mcpApp("inserted-app"), baseContent[3]],
        utc(2026, 6, 4, 10),
      ),
    ]);

    expect(secondAppRowId).toBe(
      "message:assistant-stable-companions:companion-mcpApp-second-app",
    );
    expect(second.rows.some((row) => row.rowId === secondAppRowId)).toBe(true);
  });

  it("keeps active assistant text inside agent work until streaming completes", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-streaming-work",
      "assistant",
      [
        { type: "thinking", text: "Planning" },
        toolRequest("tool-1"),
        { type: "text", text: "This may become the final answer." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant], "assistant-streaming-work");

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-streaming-work",
      "message:assistant-streaming-work:agent-work",
    ]);
    const workRow = rowById(
      snapshot,
      "message:assistant-streaming-work:agent-work",
    );
    expect(workRow.agentWork?.content.map((content) => content.type)).toEqual([
      "thinking",
      "toolRequest",
      "text",
    ]);
  });

  it("keeps final text outside the agent work row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-reasoning-tools-text",
      "assistant",
      [
        { type: "thinking", text: "I should inspect the files first." },
        toolRequest("tool-1"),
        { type: "text", text: "Here are my findings." },
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-04:before:assistant-reasoning-tools-text",
      "message:assistant-reasoning-tools-text:agent-work",
      "message:assistant-reasoning-tools-text:answer",
    ]);
    expect(
      rowById(snapshot, "message:assistant-reasoning-tools-text:agent-work")
        .kind,
    ).toBe("agent-work");
    expect(
      rowById(snapshot, "message:assistant-reasoning-tools-text:answer").kind,
    ).toBe("message");
  });

  it("keeps pre-tool progress text inside the agent work row", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-mixed",
      "assistant",
      [
        { type: "text", text: longText("mixed fragment", 92) },
        toolRequest("tool-1"),
      ],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-mixed");

    expect(row.kind).toBe("agent-work");
    expect(row.rowId).toBe("message:assistant-mixed:agent-work");
    expect(row.agentWork?.textCount).toBe(1);
    expect(row.agentWork?.toolCount).toBe(1);
    expect(snapshot.fragmentRowCount).toBe(0);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(0);
  });

  it("does not change row identity for visible-neutral metadata updates", () => {
    const cache = createTranscriptProjectionCache();
    const user = message("user-1", "user", "prompt", utc(2026, 6, 4, 10));
    const assistant = message(
      "assistant-1",
      "assistant",
      "answer",
      utc(2026, 6, 4, 10, 1),
      { agentVisible: true },
    );

    const first = update(cache, [user, assistant]);
    const second = update(cache, [
      user,
      {
        ...assistant,
        metadata: { ...assistant.metadata, agentVisible: false },
      },
    ]);

    expect(messageRow(second, "assistant-1")).toBe(
      messageRow(first, "assistant-1"),
    );
    expect(second.descriptorChurn).toBe(0);
  });

  it("filters hidden messages and creates date separators for visible groups", () => {
    const cache = createTranscriptProjectionCache();
    const visibleYesterday = message(
      "user-1",
      "user",
      "visible yesterday",
      utc(2026, 6, 3, 12),
    );
    const hiddenToday = message(
      "hidden-1",
      "assistant",
      "hidden",
      utc(2026, 6, 4, 12),
      { userVisible: false },
    );
    const emptyStreaming = {
      ...message("empty-1", "assistant", "", utc(2026, 6, 4, 12, 1), {
        completionStatus: "inProgress",
      }),
      content: [],
    };
    const visibleToday = message(
      "assistant-1",
      "assistant",
      "visible today",
      utc(2026, 6, 4, 12, 2),
    );

    const snapshot = update(cache, [
      visibleYesterday,
      hiddenToday,
      emptyStreaming,
      visibleToday,
    ]);

    expect(snapshot.rows.map((row) => row.rowId)).toEqual([
      "date:2026-06-03:before:user-1",
      "message:user-1",
      "date:2026-06-04:before:assistant-1",
      "message:assistant-1",
    ]);
    expect(snapshot.rows[0]?.date?.labelKey).toBe("yesterday");
    expect(snapshot.rows[2]?.date?.labelKey).toBe("today");
    expect(snapshot.rowByMessageId.has("hidden-1")).toBe(false);
    expect(snapshot.rowByMessageId.has("empty-1")).toBe(false);
    expect(snapshot.searchableTextByMessageId.get("assistant-1")).toBe(
      "visible today",
    );
  });

  it("does not project empty user messages into measurable rows", () => {
    const cache = createTranscriptProjectionCache();
    const emptyUser = messageWithContent(
      "empty-user",
      "user",
      [],
      utc(2026, 6, 4, 10),
    );
    const assistant = message(
      "assistant-1",
      "assistant",
      "answer",
      utc(2026, 6, 4, 10, 1),
    );

    const snapshot = update(cache, [emptyUser, assistant]);

    expect(snapshot.rowByMessageId.has("empty-user")).toBe(false);
    expect(snapshot.messageById.has("empty-user")).toBe(false);
    expect(snapshot.rows.some((row) => row.messageId === "empty-user")).toBe(
      false,
    );
    expect(snapshot.rows[0]).toMatchObject({
      rowId: "date:2026-06-04:before:assistant-1",
      date: { firstMessageId: "assistant-1" },
    });
    expect(messageRow(snapshot, "assistant-1").rowId).toBe(
      "message:assistant-1",
    );
  });

  it("separates render and height revisions for timestamp-only updates", () => {
    const original = message("user-1", "user", "same", utc(2026, 6, 4, 10));
    const changedTimestamp = {
      ...original,
      created: utc(2026, 6, 4, 10, 30),
    };

    const first = buildMessageRevisions(original);
    const second = buildMessageRevisions(changedTimestamp);

    expect(second.renderRevision).not.toBe(first.renderRevision);
    expect(second.heightRevision).toBe(first.heightRevision);
  });

  it("invalidates measured height when speech status appears", () => {
    const original = message(
      "assistant-1",
      "assistant",
      "same",
      utc(2026, 6, 4, 10),
    );
    const spoken = {
      ...original,
      content: original.content.map((content) =>
        content.type === "text"
          ? { ...content, speech: { status: "spoken" as const } }
          : content,
      ),
    };

    const first = buildMessageRevisions(original);
    const second = buildMessageRevisions(spoken);

    expect(second.renderRevision).not.toBe(first.renderRevision);
    expect(second.heightRevision).not.toBe(first.heightRevision);
  });

  it("invalidates render and height revisions when the interruption cutoff changes", () => {
    const original = message(
      "assistant-1",
      "assistant",
      "One. Two. Three.",
      utc(2026, 6, 4, 10),
    );
    const interrupted = (spokenThrough: number) => ({
      ...original,
      content: original.content.map((content) =>
        content.type === "text"
          ? {
              ...content,
              speech: {
                status: "interrupted" as const,
                spokenThrough,
                confidence: "medium" as const,
              },
            }
          : content,
      ),
    });

    const first = buildMessageRevisions(interrupted("One.".length));
    const second = buildMessageRevisions(interrupted("One. Two.".length));

    expect(second.renderRevision).not.toBe(first.renderRevision);
    expect(second.heightRevision).not.toBe(first.heightRevision);
  });

  it("includes user message origin in render and height revisions", () => {
    const original = message("user-1", "user", "same", utc(2026, 6, 4, 10));
    const withOrigin = {
      ...original,
      metadata: {
        ...original.metadata,
        origin: "berdctl_cross_session" as const,
      },
    };

    const first = buildMessageRevisions(original);
    const second = buildMessageRevisions(withOrigin);

    expect(second.renderRevision).not.toBe(first.renderRevision);
    expect(second.heightRevision).not.toBe(first.heightRevision);
  });

  it("includes realtime coordination kind in render and height revisions", () => {
    const original = message(
      "assistant-1",
      "assistant",
      "same",
      utc(2026, 6, 4, 10),
    );
    const coordination = {
      ...original,
      metadata: {
        ...original.metadata,
        voiceConversationDebugEvent: "masterToEmissarySay" as const,
      },
    };

    const first = buildMessageRevisions(original);
    const second = buildMessageRevisions(coordination);

    expect(second.renderRevision).not.toBe(first.renderRevision);
    expect(second.heightRevision).not.toBe(first.heightRevision);
  });

  it.each([
    ["agent identity", { subagentAgentName: "Rivet" }],
    ["task description", { subagentTaskLabel: "Count markdown files" }],
    ["configured task", { subagentTaskIsConfigured: true }],
  ] satisfies Array<
    [string, Partial<ToolRequestContent>]
  >)("invalidates tool rows for provenance-only %s updates", (_label, provenance) => {
    const originalRequest: ToolRequestContent = {
      type: "toolRequest",
      id: "tool-1",
      name: "load",
      arguments: { task_id: "20260807_72" },
      status: "pending",
    };
    const original = messageWithContent(
      "assistant-1",
      "assistant",
      [originalRequest],
      utc(2026, 6, 4, 10),
    );
    const updated = {
      ...original,
      content: [{ ...originalRequest, ...provenance }],
    };

    const before = buildMessageRevisions(original);
    const after = buildMessageRevisions(updated);

    expect(after.renderRevision).not.toBe(before.renderRevision);
    expect(after.heightRevision).not.toBe(before.heightRevision);
  });

  it("classifies active tool rows as estimate-only keepalive candidates", () => {
    const cache = createTranscriptProjectionCache();
    const toolRequest: ToolRequestContent = {
      type: "toolRequest",
      id: "tool-1",
      name: "read_file",
      arguments: { path: "README.md" },
      status: "pending",
      startedAt: utc(2026, 6, 4, 10),
    };
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [toolRequest],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-1");

    expect(row.capabilities.stateful).toBe(true);
    expect(row.capabilities.hasActiveTimer).toBe(true);
    expect(row.capabilities.hasActiveToolWork).toBe(true);
    expect(row.measurementPolicy).toBe("estimate-only");
    expect(row.keepAlivePriority).toBe("active-stream");
    expect(row.measurementSafetyReasons).toEqual(
      expect.arrayContaining(["active-tool", "active-timer"]),
    );
    expect(row.reactKey).toBe(row.rowId);
  });

  it("applies row spacing to agent work rows after user messages", () => {
    const cache = createTranscriptProjectionCache();
    const user = message("user-1", "user", "prompt", utc(2026, 6, 4, 10));
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [
        {
          type: "toolRequest",
          id: "tool-1",
          name: "read_file",
          arguments: { path: "README.md" },
          status: "completed",
          startedAt: utc(2026, 6, 4, 10, 1),
        },
      ],
      utc(2026, 6, 4, 10, 1),
    );

    const snapshot = update(cache, [user, assistant]);
    const row = rowById(snapshot, "message:assistant-1:agent-work");

    expect(row.spacingBefore).toBe(16);
    expect(row.layoutRevision).toBe("layout-spacing:16");
  });

  it("uses measurement policy decisions for MCP app rows", () => {
    const cache = createTranscriptProjectionCache();
    const mcpApp: McpAppContent = {
      type: "mcpApp",
      id: "mcp-app-1",
      payload: {
        sessionId: "mcp-session-1",
        toolCallId: "tool-1",
        toolCallTitle: "Preview",
        source: "toolCallUpdateMeta",
        tool: {
          name: "preview",
          extensionName: "mcp",
          resourceUri: "ui://preview",
        },
        resource: { result: null },
      },
    };
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [mcpApp],
      utc(2026, 6, 4, 10),
    );

    const snapshot = update(cache, [assistant]);
    const row = messageRow(snapshot, "assistant-1");

    expect(row.measurementPolicy).toBe("measure-shell");
    expect(row.layoutPendingPolicy).toBe("requires-stable-descendants");
    expect(row.capabilities.hasMcpApp).toBe(true);
    expect(row.capabilities.hasHostCalls).toBe(true);
    expect(row.capabilities.canOffscreenRenderReal).toBe(false);
    expect(row.capabilities.canOffscreenRenderShell).toBe(true);
    expect(row.measurementSafetyReasons).toEqual(
      expect.arrayContaining(["mcp-app", "host-calls"]),
    );
  });

  it("invalidates calendar separator rows without changing message rows", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "hello", utc(2026, 6, 4, 10)),
      message("assistant-1", "assistant", "hi", utc(2026, 6, 4, 10, 1)),
    ];

    const first = update(cache, messages);
    cache.invalidateCalendarLabels(NOW_BUCKET, LOCALE_KEY);
    const second = update(cache, messages);

    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(second.rows[1]).toBe(first.rows[1]);
    expect(second.rows[2]).toBe(first.rows[2]);
    expect([...second.changedRowIds]).toEqual([
      "date:2026-06-04:before:user-1",
    ]);
  });

  it("indexes tool location artifacts by session, message, tool, and location revision", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [
        toolRequest("tool-1", [
          { path: "/tmp/report.md", line: 7 },
          { path: "relative/output.json" },
        ]),
      ],
      utc(2026, 6, 4, 10),
    );

    const first = update(cache, [assistant]);
    const second = update(cache, [
      {
        ...assistant,
        content: [...assistant.content],
      },
    ]);
    const artifactKeys =
      first.artifactIndex.artifactKeysByMessageId.get("assistant-1");

    expect(first.artifactIndex.artifacts).toHaveLength(2);
    expect(artifactKeys).toHaveLength(2);
    expect(
      first.artifactIndex.artifactKeysByToolRequestId.get("tool-1"),
    ).toEqual(artifactKeys);
    expect(
      first.artifactIndex.artifactKeysByRowId.get(
        "message:assistant-1:agent-work",
      ),
    ).toEqual(artifactKeys);
    expect(first.artifactIndex.artifacts[0]?.artifactKey).toMatch(
      /^artifact:session-1:assistant-1:tool-1:/,
    );
    expect(first.artifactIndex.artifacts[0]?.path).toBe("/tmp/report.md");
    expect(first.artifactIndex.artifacts[0]?.line).toBe(7);
    expect(second.artifactIndex.artifacts[0]).toBe(
      first.artifactIndex.artifacts[0],
    );
    expect([...second.artifactIndex.changedArtifactKeys]).toEqual([]);
  });

  it("preserves unchanged row identity across artifact-only updates", () => {
    const cache = createTranscriptProjectionCache();
    const user = message("user-1", "user", "prompt", utc(2026, 6, 4, 10));
    const assistantWithArtifact = messageWithContent(
      "assistant-1",
      "assistant",
      [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }])],
      utc(2026, 6, 4, 10, 1),
    );
    const assistantText = message(
      "assistant-2",
      "assistant",
      "unchanged",
      utc(2026, 6, 4, 10, 2),
    );

    const first = update(cache, [user, assistantWithArtifact, assistantText]);
    const second = update(cache, [
      user,
      {
        ...assistantWithArtifact,
        content: [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 9 }])],
      },
      assistantText,
    ]);

    expect(second.rows[0]).toBe(first.rows[0]);
    expect(messageRow(second, "user-1")).toBe(messageRow(first, "user-1"));
    expect(messageRow(second, "assistant-1")).not.toBe(
      messageRow(first, "assistant-1"),
    );
    expect(messageRow(second, "assistant-2")).toBe(
      messageRow(first, "assistant-2"),
    );
    expect([...second.changedRowIds]).toEqual([
      "message:assistant-1:agent-work",
    ]);
    expect(second.artifactIndex.artifacts).toHaveLength(1);
    expect(second.artifactIndex.artifacts[0]?.line).toBe(9);
    expect(second.artifactIndex.changedArtifactKeys.size).toBe(2);
  });

  it("preserves row identity when promoting a draft session", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "prompt", utc(2026, 6, 4, 10)),
      messageWithContent(
        "assistant-1",
        "assistant",
        [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }])],
        utc(2026, 6, 4, 10, 1),
      ),
    ];

    const draft = updateSession(cache, "draft-session", messages);
    cache.promoteSession("draft-session", "real-session");
    const promoted = updateSession(cache, "real-session", messages);

    expect(promoted.rows[0]).toBe(draft.rows[0]);
    expect(promoted.rows[1]).toBe(draft.rows[1]);
    expect(promoted.rows[2]).toBe(draft.rows[2]);
    expect(promoted.descriptorChurn).toBe(0);
    expect(promoted.artifactIndex.artifacts[0]?.sessionId).toBe("real-session");
    expect(promoted.artifactIndex.artifacts[0]?.artifactKey).toMatch(
      /^artifact:real-session:assistant-1:tool-1:/,
    );
  });

  it("drops cached descriptors and artifacts on cleanup", () => {
    const cache = createTranscriptProjectionCache();
    const messages = [
      message("user-1", "user", "prompt", utc(2026, 6, 4, 10)),
      messageWithContent(
        "assistant-1",
        "assistant",
        [toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }])],
        utc(2026, 6, 4, 10, 1),
      ),
    ];

    const first = update(cache, messages);
    cache.cleanupSession(SESSION_ID);
    const second = update(cache, messages);

    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(second.rows[1]).not.toBe(first.rows[1]);
    expect(second.rows[2]).not.toBe(first.rows[2]);
    expect(second.descriptorChurn).toBe(0);
    expect(second.changedRowIds.size).toBe(second.rows.length);
    expect(second.artifactIndex.artifacts[0]).not.toBe(
      first.artifactIndex.artifacts[0],
    );
  });

  it("restores cached row descriptors when returning to a session", () => {
    const cache = createTranscriptProjectionCache();
    const sessionOneMessages = [
      message("user-1", "user", "prompt", utc(2026, 6, 4, 10)),
      message("assistant-1", "assistant", "answer", utc(2026, 6, 4, 10, 1)),
    ];
    const sessionTwoMessages = [
      message("user-2", "user", "other", utc(2026, 6, 4, 11)),
    ];

    const first = updateSession(cache, "session-one", sessionOneMessages);
    updateSession(cache, "session-two", sessionTwoMessages);
    const restored = updateSession(
      cache,
      "session-one",
      cloneMessages(sessionOneMessages),
    );

    expect(restored.rows[0]).toBe(first.rows[0]);
    expect(restored.rows[1]).toBe(first.rows[1]);
    expect(restored.rows[2]).toBe(first.rows[2]);
    expect(restored.descriptorChurn).toBe(0);
  });

  it("keeps stateful React identity separate from PR 928 anchor revisions", () => {
    const cache = createTranscriptProjectionCache();
    const assistant = messageWithContent(
      "assistant-1",
      "assistant",
      [
        {
          ...toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }]),
          status: "in_progress",
          startedAt: utc(2026, 6, 4, 10),
        },
      ],
      utc(2026, 6, 4, 10),
    );

    const first = update(cache, [assistant]);
    const before = messageRow(first, "assistant-1");
    const second = update(cache, [
      {
        ...assistant,
        content: [
          {
            ...toolRequest("tool-1", [{ path: "/tmp/report.md", line: 7 }]),
            status: "completed",
          },
        ],
      },
    ]);
    const after = messageRow(second, "assistant-1");

    expect(after).not.toBe(before);
    expect(after.rowId).toBe(before.rowId);
    expect(after.reactKey).toBe(before.reactKey);
    expect(after.reactKey).toBe(after.rowId);
    expect(after.reactKey).not.toContain(after.heightRevision);
    expect(after.heightRevision).not.toBe(before.heightRevision);
    expect(after.measurementPolicy).not.toBe(before.measurementPolicy);
  });
});

function update(
  cache: ReturnType<typeof createTranscriptProjectionCache>,
  messages: readonly Message[],
  streamingMessageId: string | null = null,
): TranscriptProjectionSnapshot {
  return updateSession(cache, SESSION_ID, messages, streamingMessageId);
}

function updateSession(
  cache: ReturnType<typeof createTranscriptProjectionCache>,
  sessionId: string,
  messages: readonly Message[],
  streamingMessageId: string | null = null,
): TranscriptProjectionSnapshot {
  return cache.update({
    sessionId,
    sessionEpoch: 1,
    messages,
    streamingMessageId,
    nowBucket: NOW_BUCKET,
    localeKey: LOCALE_KEY,
  });
}

function messageRow(
  snapshot: TranscriptProjectionSnapshot,
  messageId: string,
): TranscriptRowDescriptor {
  const rowId = snapshot.rowByMessageId.get(messageId);
  expect(rowId).toBeDefined();
  const rowIndex = snapshot.rowIndexById.get(rowId ?? "");
  expect(rowIndex).toBeDefined();
  const row = snapshot.rows[rowIndex ?? -1];
  expect(row).toBeDefined();
  return row;
}

function rowById(
  snapshot: TranscriptProjectionSnapshot,
  rowId: string,
): TranscriptRowDescriptor {
  const rowIndex = snapshot.rowIndexById.get(rowId);
  expect(rowIndex).toBeDefined();
  const row = snapshot.rows[rowIndex ?? -1];
  expect(row).toBeDefined();
  return row;
}

function message(
  id: string,
  role: Message["role"],
  text: string,
  created: number,
  metadata: MessageMetadata = {},
): Message {
  return messageWithContent(
    id,
    role,
    text ? [{ type: "text", text }] : [],
    created,
    metadata,
  );
}

function messageWithContent(
  id: string,
  role: Message["role"],
  content: MessageContent[],
  created: number,
  metadata: MessageMetadata = {},
): Message {
  return {
    id,
    role,
    created,
    content,
    metadata: {
      userVisible: true,
      ...metadata,
    },
  };
}

function toolRequest(
  id: string,
  locations: ToolRequestContent["locations"] = [],
): ToolRequestContent {
  return {
    type: "toolRequest",
    id,
    name: "write_file",
    toolName: "write_file",
    arguments: { path: locations[0]?.path ?? "/tmp/report.md" },
    status: "completed",
    toolKind: "edit",
    locations,
  };
}

function toolResponse(id: string): ToolResponseContent {
  return {
    type: "toolResponse",
    id,
    name: "write_file",
    result: "ok",
    isError: false,
  };
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return structuredClone(messages) as Message[];
}

function longText(label: string, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `${label} line ${String(index).padStart(3, "0")}`,
  ).join("\n");
}

function longMarkdownTable(label: string, rowCount: number): string {
  return [
    "| Name | Value |",
    "| --- | --- |",
    ...Array.from(
      { length: rowCount },
      (_, index) => `| ${label} ${String(index).padStart(3, "0")} | ${index} |`,
    ),
  ].join("\n");
}

function multiParagraphText(
  label: string,
  paragraphCount: number,
  linesPerParagraph: number,
): string {
  return Array.from({ length: paragraphCount }, (_, pIndex) =>
    Array.from(
      { length: linesPerParagraph },
      (_, lIndex) =>
        `${label} p${pIndex} line ${String(lIndex).padStart(3, "0")}`,
    ).join("\n"),
  ).join("\n\n");
}

function longTildeCodeBlock(lineCount: number): string {
  return [
    "~~~ts",
    ...Array.from(
      { length: lineCount },
      (_, index) => `const value${index} = ${index};`,
    ),
    "~~~",
  ].join("\n");
}

function textWithCodeBlock(codeLineCount: number): string {
  const intro = Array.from(
    { length: 10 },
    (_, index) => `intro line ${String(index).padStart(3, "0")}`,
  ).join("\n");
  const code = [
    "```typescript",
    ...Array.from(
      { length: codeLineCount },
      (_, index) => `const x${index} = ${index};`,
    ),
    "```",
  ].join("\n");
  const outro = Array.from(
    { length: 10 },
    (_, index) => `outro line ${String(index).padStart(3, "0")}`,
  ).join("\n");
  return `${intro}\n${code}\n${outro}`;
}

function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}
