import { describe, expect, it } from "vitest";
import type {
  McpAppContent,
  Message,
  MessageContent,
  MessageMetadata,
  ToolRequestContent,
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

  it("keeps unsupported assistant content on whole-message fallback rows", () => {
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

    expect(row.kind).toBe("message");
    expect(row.rowId).toBe("message:assistant-mixed");
    expect(snapshot.fragmentRowCount).toBe(0);
    expect(snapshot.wholeMessageFallbackRowCount).toBe(1);
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
        "message:assistant-1:tool-chain",
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
      "message:assistant-1:tool-chain",
      "message:assistant-1:tool-chain-detail",
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
