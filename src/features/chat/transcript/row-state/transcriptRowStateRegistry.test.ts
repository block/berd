import { describe, expect, it } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY,
  createTranscriptRowStateRegistry,
} from "./transcriptRowStateRegistry";

const SESSION_ID = "session-1";

describe("transcript row state registry", () => {
  it("evicts recent keepalive rows by cap and prunes TTL without dropping durable state", () => {
    const registry = createTranscriptRowStateRegistry({
      recentRowsPerSessionCap: 2,
      recentTtlMs: 50,
    });

    registry.patchRowState({
      sessionId: SESSION_ID,
      rowId: "row-1",
      nowMs: 1,
      patch: { pathNoticeText: "first" },
    });
    registry.markRowInteracted({
      sessionId: SESSION_ID,
      rowId: "row-2",
      nowMs: 2,
    });
    registry.markRowInteracted({
      sessionId: SESSION_ID,
      rowId: "row-3",
      nowMs: 3,
    });

    const capped = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("row-1"), row("row-2"), row("row-3")],
      nowMs: 30,
    });

    expect(capped.protectedRowIds).toEqual(["row-2", "row-3"]);
    expect(capped.evictedRowIds).toEqual(["row-1"]);
    expect(capped.diagnostics.recentCandidateCount).toBe(3);
    expect(capped.diagnostics.evictedRecentRowCount).toBe(1);

    const expired = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("row-1"), row("row-2"), row("row-3")],
      nowMs: 60,
    });

    expect(expired.protectedRowIds).toEqual([]);
    expect(expired.diagnostics.expiredSignalCount).toBe(3);
    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: "row-1" }),
    ).toEqual({ pathNoticeText: "first" });
  });

  it("keeps focused, selected, open-overlay, and active-stream rows protected outside caps", () => {
    const registry = createTranscriptRowStateRegistry({
      mcpRowsPerSessionCap: 0,
      recentRowsPerSessionCap: 0,
      protectedRowsWarnThreshold: 2,
      protectedRowsFailThreshold: 3,
    });

    registry.setFocusedRow({
      sessionId: SESSION_ID,
      rowId: "focused",
      focused: true,
      focusTargetId: "copy-button",
      nowMs: 1,
    });
    registry.setSelectionProtection({
      sessionId: SESSION_ID,
      rowIds: ["selected"],
      active: true,
      contextMenuOpen: true,
      nowMs: 2,
    });
    registry.setOpenOverlay({
      sessionId: SESSION_ID,
      rowId: "overlay",
      open: true,
      overlayKind: "popover",
      overlayId: "tool-menu",
      nowMs: 3,
    });
    registry.setActiveStreamingRow({
      sessionId: SESSION_ID,
      rowId: "streaming",
      active: true,
      nowMs: 4,
    });
    registry.markRowInteracted({
      sessionId: SESSION_ID,
      rowId: "recent",
      nowMs: 5,
    });

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [
        row("focused"),
        row("selected"),
        row("overlay"),
        row("streaming"),
        row("recent"),
      ],
      visibleRowIds: ["focused"],
      nowMs: 10,
    });

    expect(decision.protectedRowIds).toEqual([
      "focused",
      "overlay",
      "selected",
      "streaming",
    ]);
    expect(decision.protectedOffscreenRowIds).toEqual([
      "overlay",
      "selected",
      "streaming",
    ]);
    expect(decision.evictedRowIds).toEqual(["recent"]);
    expect(decision.diagnostics.forcedProtectedRowCount).toBe(4);
    expect(decision.diagnostics.warnThresholdExceeded).toBe(true);
    expect(decision.diagnostics.failThresholdExceeded).toBe(false);
    expect(decision.diagnostics.failThresholdJustifiedByActiveInteraction).toBe(
      true,
    );
  });

  it("enforces MCP keepalive caps by newest activity", () => {
    const registry = createTranscriptRowStateRegistry({
      mcpRowsPerSessionCap: 2,
    });

    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-1",
      active: true,
      kind: "host-request",
      nowMs: 1,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-2",
      active: true,
      kind: "host-request",
      nowMs: 2,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-3",
      active: true,
      kind: "host-request",
      nowMs: 3,
    });

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("mcp-1"), row("mcp-2"), row("mcp-3")],
      nowMs: 10,
    });

    expect(decision.protectedRowIds).toEqual(["mcp-2", "mcp-3"]);
    expect(decision.evictedRowIds).toEqual(["mcp-1"]);
    expect(decision.diagnostics.mcpCandidateCount).toBe(3);
    expect(decision.diagnostics.mcpProtectedRowCount).toBe(2);
    expect(decision.diagnostics.evictedMcpRowCount).toBe(1);
  });

  it("uses the documented default MCP cap and threshold policy values", () => {
    const registry = createTranscriptRowStateRegistry();

    for (let index = 1; index <= 9; index += 1) {
      registry.setMcpActivity({
        sessionId: SESSION_ID,
        rowId: `mcp-${index}`,
        active: true,
        kind: "host-request",
        nowMs: index,
      });
    }

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: Array.from({ length: 9 }, (_, index) => row(`mcp-${index + 1}`)),
      nowMs: 20,
    });

    expect(decision.diagnostics.policy).toEqual(
      DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY,
    );
    expect(decision.protectedRowIds).toEqual([
      "mcp-2",
      "mcp-3",
      "mcp-4",
      "mcp-5",
      "mcp-6",
      "mcp-7",
      "mcp-8",
      "mcp-9",
    ]);
    expect(decision.evictedRowIds).toEqual(["mcp-1"]);
    expect(decision.diagnostics.mcpCandidateCount).toBe(9);
    expect(decision.diagnostics.mcpProtectedRowCount).toBe(8);
    expect(decision.diagnostics.evictedMcpRowCount).toBe(1);
    expect(decision.diagnostics.warnThresholdExceeded).toBe(false);
    expect(decision.diagnostics.failThresholdExceeded).toBe(false);
  });

  it("caps stale active streams without evicting interaction-protected rows", () => {
    // Regression: active-stream protection signals have no TTL and rely on an
    // explicit release. Keep their bounded backstop separate from genuine user
    // interactions so large selections remain mounted while stale streams go.
    const registry = createTranscriptRowStateRegistry();
    const selectedRowIds = Array.from(
      { length: 64 },
      (_, index) => `selected-${index + 1}`,
    );

    registry.setSelectionProtection({
      sessionId: SESSION_ID,
      rowIds: selectedRowIds,
      active: true,
      nowMs: 1,
    });
    for (let index = 1; index <= 300; index += 1) {
      registry.setActiveStreamingRow({
        sessionId: SESSION_ID,
        rowId: `stream-${index}`,
        active: true,
        nowMs: index + 1,
      });
    }

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [
        ...selectedRowIds.map((rowId) => row(rowId)),
        ...Array.from({ length: 300 }, (_, index) =>
          row(`stream-${index + 1}`),
        ),
      ],
      nowMs: 1000,
    });

    expect(decision.protectedRowIds).toEqual(
      expect.arrayContaining(selectedRowIds),
    );
    expect(
      decision.protectedRowIds.filter((rowId) => rowId.startsWith("stream-")),
    ).toHaveLength(
      DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY.activeStreamRowsPerSessionCap,
    );
    expect(decision.evictedRowIds).not.toEqual(
      expect.arrayContaining(selectedRowIds),
    );
    expect(decision.evictedRowIds).toContain("stream-1");
    expect(decision.protectedRowIds).toContain("stream-300");
    expect(decision.diagnostics.failThresholdExceeded).toBe(false);
    expect(decision.diagnostics.failThresholdJustifiedByActiveInteraction).toBe(
      true,
    );
  });

  it("keeps the newest projection streams when active rows exceed the cap", () => {
    const registry = createTranscriptRowStateRegistry({
      activeStreamRowsPerSessionCap: 3,
    });
    const rows = [
      row("stream-z", { keepAlivePriority: "active-stream" }),
      row("stream-a", { keepAlivePriority: "active-stream" }),
      row("stream-y", { keepAlivePriority: "active-stream" }),
      row("stream-b", { keepAlivePriority: "active-stream" }),
      row("stream-x", { keepAlivePriority: "active-stream" }),
    ];

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows,
      nowMs: 100,
    });

    expect(decision.protectedRowIds).toEqual([
      "stream-b",
      "stream-x",
      "stream-y",
    ]);
    expect(decision.evictedRowIds).toEqual(["stream-a", "stream-z"]);
  });

  it("keeps active MCP rows protected when their stream signal exceeds the stream cap", () => {
    const registry = createTranscriptRowStateRegistry({
      activeStreamRowsPerSessionCap: 39,
      mcpRowsPerSessionCap: 1,
    });

    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "stream-1",
      active: true,
      kind: "host-request",
      nowMs: 0,
    });
    for (let index = 1; index <= 41; index += 1) {
      registry.setActiveStreamingRow({
        sessionId: SESSION_ID,
        rowId: `stream-${index}`,
        active: true,
        nowMs: index,
      });
    }

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: Array.from({ length: 41 }, (_, index) =>
        row(`stream-${index + 1}`),
      ),
      nowMs: 200,
    });

    expect(decision.protectedRowIds).toContain("stream-1");
    expect(decision.evictedRowIds).not.toContain("stream-1");
    expect(decision.evictedRowIds).toContain("stream-2");
    expect(decision.diagnostics.mcpProtectedRowCount).toBe(1);
    expect(decision.diagnostics.evictedMcpRowCount).toBe(0);
  });

  it("expires recent MCP keepalive signals without clearing active host work", () => {
    const registry = createTranscriptRowStateRegistry({
      mcpRowsPerSessionCap: 4,
      recentTtlMs: 50,
    });

    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-host",
      active: true,
      kind: "host-request",
      sourceId: "host-request-1",
      nowMs: 1,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-nested",
      active: true,
      kind: "nested-tool-request",
      sourceId: "nested-tool-1",
      nowMs: 2,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-message",
      active: true,
      kind: "recent-message",
      nowMs: 3,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-resize",
      active: true,
      kind: "recent-resize",
      nowMs: 4,
    });

    const fresh = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [
        row("mcp-host"),
        row("mcp-nested"),
        row("mcp-message"),
        row("mcp-resize"),
      ],
      nowMs: 20,
    });

    expect(fresh.protectedRowIds).toEqual([
      "mcp-host",
      "mcp-message",
      "mcp-nested",
      "mcp-resize",
    ]);
    expect(fresh.diagnostics.expiredSignalCount).toBe(0);
    expect(fresh.diagnostics.mcpCandidateCount).toBe(4);

    const expired = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [
        row("mcp-host"),
        row("mcp-nested"),
        row("mcp-message"),
        row("mcp-resize"),
      ],
      nowMs: 60,
    });

    expect(expired.protectedRowIds).toEqual(["mcp-host", "mcp-nested"]);
    expect(expired.diagnostics.expiredSignalCount).toBe(2);
    expect(expired.diagnostics.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowId: "mcp-host",
          reasons: ["active-mcp"],
          protected: true,
        }),
        expect.objectContaining({
          rowId: "mcp-nested",
          reasons: ["active-mcp"],
          protected: true,
        }),
      ]),
    );
  });

  it("drops stale session-epoch MCP callbacks instead of recreating protection", () => {
    const registry = createTranscriptRowStateRegistry();

    registry.setMcpActivity({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      rowId: "mcp-current",
      active: true,
      kind: "host-request",
      nowMs: 1,
    });
    registry.setSessionEpoch(SESSION_ID, 2);

    const staleCallbackAccepted = registry.setMcpActivity({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      rowId: "mcp-stale",
      active: true,
      kind: "host-request",
      nowMs: 2,
    });

    expect(staleCallbackAccepted).toBe(false);

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      sessionEpoch: 2,
      rows: [row("mcp-current"), row("mcp-stale")],
      nowMs: 3,
    });

    expect(decision.protectedRowIds).toEqual(["mcp-current"]);
    expect(decision.diagnostics.rows.map((entry) => entry.rowId)).toEqual([
      "mcp-current",
    ]);
    expect(
      registry.getRowState({
        sessionId: SESSION_ID,
        sessionEpoch: 2,
        rowId: "mcp-stale",
      }),
    ).toBeUndefined();
  });

  it("reports MCP cap pressure and fail thresholds without active interaction exemption", () => {
    const registry = createTranscriptRowStateRegistry({
      mcpRowsPerSessionCap: 3,
      protectedRowsWarnThreshold: 1,
      protectedRowsFailThreshold: 2,
      recentRowsPerSessionCap: 0,
    });

    for (let index = 1; index <= 3; index += 1) {
      registry.setMcpActivity({
        sessionId: SESSION_ID,
        rowId: `mcp-${index}`,
        active: true,
        kind: "host-request",
        nowMs: index,
      });
    }

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("mcp-1"), row("mcp-2"), row("mcp-3")],
      nowMs: 10,
    });

    expect(decision.protectedRowIds).toEqual(["mcp-1", "mcp-2", "mcp-3"]);
    expect(decision.diagnostics.warnThresholdExceeded).toBe(true);
    expect(decision.diagnostics.failThresholdExceeded).toBe(true);
    expect(decision.diagnostics.failThresholdJustifiedByActiveInteraction).toBe(
      false,
    );
  });

  it("promotes draft-session state and protections, then cleans them up", () => {
    const registry = createTranscriptRowStateRegistry();

    registry.patchRowState({
      sessionId: "draft-session",
      rowId: "message:assistant-1",
      markRecent: false,
      patch: { reasoning: { open: true } },
    });
    registry.setFocusedRow({
      sessionId: "draft-session",
      rowId: "message:assistant-1",
      focused: true,
    });

    const promotion = registry.promoteSession(
      "draft-session",
      "backend-session",
      {
        newSessionEpoch: 7,
      },
    );

    expect(promotion).toEqual({
      oldSessionId: "draft-session",
      newSessionId: "backend-session",
      promotedRowStateCount: 1,
      promotedProtectionSignalCount: 1,
      mergedIntoExistingSession: false,
    });
    expect(
      registry.getRowState({
        sessionId: "draft-session",
        rowId: "message:assistant-1",
      }),
    ).toBeUndefined();
    expect(
      registry.getRowState({
        sessionId: "backend-session",
        rowId: "message:assistant-1",
      }),
    ).toEqual({ reasoning: { open: true } });

    const decision = registry.evaluateKeepAlive({
      sessionId: "backend-session",
      sessionEpoch: 7,
      rows: [row("message:assistant-1")],
    });

    expect(decision.protectedRowIds).toEqual(["message:assistant-1"]);

    const cleanup = registry.cleanupSession("backend-session");
    expect(cleanup).toEqual({
      sessionId: "backend-session",
      removedRowStateCount: 1,
      removedProtectionSignalCount: 1,
    });
    expect(
      registry.getRowState({
        sessionId: "backend-session",
        rowId: "message:assistant-1",
      }),
    ).toBeUndefined();
  });

  it("covers all accepted keepalive reasons in current P2 policy", () => {
    const registry = createTranscriptRowStateRegistry();

    registry.setFocusedRow({
      sessionId: SESSION_ID,
      rowId: "focused",
      focused: true,
      nowMs: 1,
    });
    registry.setSelectionProtection({
      sessionId: SESSION_ID,
      rowIds: ["selection"],
      active: true,
      nowMs: 2,
    });
    registry.setSelectionProtection({
      sessionId: SESSION_ID,
      rowIds: ["selected-menu"],
      active: true,
      contextMenuOpen: true,
      nowMs: 3,
    });
    registry.setOpenOverlay({
      sessionId: SESSION_ID,
      rowId: "selected-menu",
      open: true,
      overlayKind: "context-menu",
      overlayId: "selected-text",
      nowMs: 4,
    });
    registry.setOpenOverlay({
      sessionId: SESSION_ID,
      rowId: "popover",
      open: true,
      overlayKind: "popover",
      overlayId: "tool-menu",
      nowMs: 5,
    });
    registry.setOpenOverlay({
      sessionId: SESSION_ID,
      rowId: "lightbox",
      open: true,
      overlayKind: "lightbox",
      overlayId: "image-lightbox",
      nowMs: 6,
    });
    registry.setActiveStreamingRow({
      sessionId: SESSION_ID,
      rowId: "streaming",
      active: true,
      sourceId: "stream",
      nowMs: 7,
    });
    registry.setActiveStreamingRow({
      sessionId: SESSION_ID,
      rowId: "active-tool",
      active: true,
      sourceId: "tool",
      nowMs: 8,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-host",
      active: true,
      kind: "host-request",
      nowMs: 9,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-nested",
      active: true,
      kind: "nested-tool-request",
      nowMs: 10,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-message",
      active: true,
      kind: "recent-message",
      nowMs: 11,
    });
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      rowId: "mcp-resize",
      active: true,
      kind: "recent-resize",
      nowMs: 12,
    });
    registry.markRowInteracted({
      sessionId: SESSION_ID,
      rowId: "recent",
      nowMs: 13,
    });

    const allRows = [
      "focused",
      "selection",
      "selected-menu",
      "popover",
      "lightbox",
      "streaming",
      "active-tool",
      "mcp-host",
      "mcp-nested",
      "mcp-message",
      "mcp-resize",
      "recent",
      "visible-only",
    ].map((rowId) => row(rowId));
    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: allRows,
      visibleRowIds: ["focused", "visible-only"],
      nowMs: 20,
    });
    const diagnosticsByRow = new Map(
      decision.diagnostics.rows.map((entry) => [entry.rowId, entry] as const),
    );

    expect(decision.protectedRowIds).toEqual([
      "active-tool",
      "focused",
      "lightbox",
      "mcp-host",
      "mcp-message",
      "mcp-nested",
      "mcp-resize",
      "popover",
      "recent",
      "selected-menu",
      "selection",
      "streaming",
    ]);
    expect(decision.protectedOffscreenRowIds).not.toContain("focused");
    expect(decision.protectedOffscreenRowIds).not.toContain("visible-only");
    expect(diagnosticsByRow.get("focused")).toMatchObject({
      isVisible: true,
      reasons: ["focused"],
    });
    expect(diagnosticsByRow.get("selection")?.reasons).toEqual(["selection"]);
    expect(diagnosticsByRow.get("selected-menu")?.reasons).toEqual([
      "open-overlay",
      "selection",
    ]);
    expect(diagnosticsByRow.get("popover")?.reasons).toEqual(["open-overlay"]);
    expect(diagnosticsByRow.get("lightbox")?.reasons).toEqual(["open-overlay"]);
    expect(diagnosticsByRow.get("streaming")?.reasons).toEqual([
      "active-stream",
    ]);
    expect(diagnosticsByRow.get("active-tool")?.reasons).toEqual([
      "active-stream",
    ]);
    expect(diagnosticsByRow.get("mcp-host")?.reasons).toEqual(["active-mcp"]);
    expect(diagnosticsByRow.get("mcp-nested")?.reasons).toEqual(["active-mcp"]);
    expect(diagnosticsByRow.get("mcp-message")?.reasons).toEqual([
      "active-mcp",
    ]);
    expect(diagnosticsByRow.get("mcp-resize")?.reasons).toEqual(["active-mcp"]);
    expect(diagnosticsByRow.get("recent")?.reasons).toEqual(["recent"]);
    expect(diagnosticsByRow.has("visible-only")).toBe(false);
    expect(decision.diagnostics.forcedProtectedRowCount).toBe(7);
    expect(decision.diagnostics.mcpCandidateCount).toBe(4);
    expect(decision.diagnostics.recentCandidateCount).toBe(1);
  });

  it("cleans up MCP state on session reset and rejects stale epoch callbacks", () => {
    const registry = createTranscriptRowStateRegistry();
    registry.setSessionEpoch(SESSION_ID, 5);
    registry.setMcpActivity({
      sessionId: SESSION_ID,
      sessionEpoch: 5,
      rowId: "mcp-current",
      active: true,
      kind: "host-request",
      nowMs: 1,
    });

    expect(
      registry.evaluateKeepAlive({
        sessionId: SESSION_ID,
        sessionEpoch: 5,
        rows: [row("mcp-current")],
        nowMs: 2,
      }).protectedRowIds,
    ).toEqual(["mcp-current"]);

    expect(registry.cleanupSession(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      removedRowStateCount: 1,
      removedProtectionSignalCount: 1,
    });
    expect(registry.getDiagnostics(SESSION_ID)).toBeUndefined();

    registry.setSessionEpoch(SESSION_ID, 6);
    expect(
      registry.setMcpActivity({
        sessionId: SESSION_ID,
        sessionEpoch: 5,
        rowId: "mcp-stale",
        active: true,
        kind: "host-request",
        nowMs: 3,
      }),
    ).toBe(false);
    expect(
      registry.evaluateKeepAlive({
        sessionId: SESSION_ID,
        sessionEpoch: 6,
        rows: [row("mcp-stale")],
        nowMs: 4,
      }).protectedRowIds,
    ).toEqual([]);
  });

  it("retains row state by stable row id across descriptor revisions and keepalive expiry", () => {
    const registry = createTranscriptRowStateRegistry({ recentTtlMs: 25 });
    const stateBefore = registry.patchRowState({
      sessionId: SESSION_ID,
      rowId: "message:assistant-1",
      nowMs: 1,
      patch: {
        toolChain: {
          chainExpanded: true,
          expandedToolKeys: ["tool-a"],
          userInteracted: true,
        },
      },
    });

    const protectedDecision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("message:assistant-1", { renderRevision: "render:1" })],
      nowMs: 10,
    });

    expect(protectedDecision.protectedRowIds).toEqual(["message:assistant-1"]);

    const expiredDecision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [row("message:assistant-1", { renderRevision: "render:2" })],
      nowMs: 40,
    });
    const stateAfter = registry.getRowState({
      sessionId: SESSION_ID,
      rowId: "message:assistant-1",
    });

    expect(expiredDecision.protectedRowIds).toEqual([]);
    expect(stateAfter).toBe(stateBefore);
    expect(stateAfter?.toolChain?.expandedToolKeys).toEqual(["tool-a"]);
  });
});

function row(
  rowId: string,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId.replace(/^message:/, ""),
    renderRevision: "render:1",
    heightRevision: "height:1",
    layoutRevision: overrides.layoutRevision ?? "layout-spacing:0",
    estimatedHeight: 80,
    spacingBefore: overrides.spacingBefore ?? 0,
    anchorPriority: "stable",
    measurementPolicy: "measure-shell",
    layoutPendingPolicy: "can-finalize",
    capabilities: {
      stateful: true,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: false,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: "none",
    ...overrides,
  };
}
