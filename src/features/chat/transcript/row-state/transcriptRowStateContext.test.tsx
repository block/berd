import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClickableImage } from "@/features/chat/ui/ClickableImage";
import type { TranscriptRowDescriptor } from "../projection";
import {
  TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT,
  TranscriptRowStateProvider,
  createTranscriptRowStateRegistry,
  useTranscriptActiveStreamingProtection,
  useTranscriptActiveToolProtection,
  useTranscriptMcpActivityReporter,
  useTranscriptOpenOverlayProtection,
  useTranscriptRowRootAdapter,
  useTranscriptRowStateAdapter,
} from "./index";

const SESSION_ID = "session-1";
const ROW_ID = "message-row-1";

function createRow(rowId: string = ROW_ID): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: "message-1",
    blockIds: [],
    renderRevision: "render-1",
    heightRevision: "height-1",
    layoutRevision: "layout-spacing:0",
    estimatedHeight: 120,
    spacingBefore: 0,
    anchorPriority: "stable",
    measurementPolicy: "measure-real",
    layoutPendingPolicy: "requires-stable-descendants",
    capabilities: {
      stateful: true,
      hasMcpApp: false,
      hasHostCalls: false,
      hasHostActionHandlers: false,
      hasActiveTimer: false,
      hasActiveToolWork: false,
      hasActiveMcpHostRequest: false,
      hasActiveNestedToolRequest: false,
      hasCopyFeedback: false,
      hasFocusedDescendant: false,
      protectsSelection: false,
      hasOpenOverlay: false,
      hasOpenMenu: false,
      hasOpenDialog: false,
      hasOpenPopover: false,
      hasOpenLightbox: false,
      hasPendingLayout: false,
      hasDynamicAsyncLayout: false,
      hasStreamingContent: false,
      hasImageContent: false,
      hasToolContent: false,
      hasReasoningContent: false,
      hasActionRequired: false,
      hasUnknownUnsafeDescendants: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: false,
    },
    measurementSafetyReasons: [],
    keepAlivePriority: "none",
  };
}

function RowProbe({
  overlayOpen = false,
  mcpActive = false,
  streaming = false,
  activeTool = false,
}: {
  overlayOpen?: boolean;
  mcpActive?: boolean;
  streaming?: boolean;
  activeTool?: boolean;
}) {
  const rootAttributes = useTranscriptRowRootAdapter();
  const { markRowInteracted } = useTranscriptRowStateAdapter();
  const { setMcpActivity } = useTranscriptMcpActivityReporter();

  useTranscriptActiveStreamingProtection(streaming);
  useTranscriptActiveToolProtection(activeTool);
  useTranscriptOpenOverlayProtection({
    open: overlayOpen,
    overlayId: "probe-popover",
    overlayKind: "popover",
  });

  useEffect(() => {
    if (!mcpActive) {
      return;
    }

    setMcpActivity("host-request", true, { sourceId: "probe-host" });
    return () => {
      setMcpActivity("host-request", false, { sourceId: "probe-host" });
    };
  }, [mcpActive, setMcpActivity]);

  return (
    <div data-testid="row-probe" tabIndex={-1} {...rootAttributes}>
      <button type="button" onClick={() => markRowInteracted("probe-click")}>
        focus target
      </button>
      <span>selectable row text</span>
    </div>
  );
}

describe("transcript row state context adapters", () => {
  it("stays inert without a virtual row context", () => {
    render(<RowProbe overlayOpen mcpActive streaming activeTool />);

    const row = screen.getByTestId("row-probe");
    expect(row).not.toHaveAttribute("data-virtual-row-state");

    fireEvent.focus(screen.getByRole("button", { name: /focus target/i }));
    fireEvent.click(screen.getByRole("button", { name: /focus target/i }));
  });

  it("reports focus and ignores DOM selection for the current row", () => {
    const registry = createTranscriptRowStateRegistry();
    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId={SESSION_ID}
        rowId={ROW_ID}
      >
        <RowProbe />
      </TranscriptRowStateProvider>,
    );

    const row = screen.getByTestId("row-probe");
    expect(row).toHaveAttribute("data-virtual-row-state", "enabled");
    fireEvent.focus(screen.getByRole("button", { name: /focus target/i }));

    expect(
      registry.evaluateKeepAlive({
        sessionId: SESSION_ID,
        rows: [createRow()],
        visibleRowIds: [],
      }).protectedRowIds,
    ).toContain(ROW_ID);
    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })
        ?.activeFocusTargetId,
    ).toBe("button");

    const textNode = screen.getByText("selectable row text").firstChild;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, "selectable".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })
        ?.selectionProtected,
    ).toBeUndefined();

    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })
        ?.selectionProtected,
    ).toBeUndefined();
  });

  it("reports overlay, MCP, streaming, and active tool protection signals", () => {
    const registry = createTranscriptRowStateRegistry();
    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId={SESSION_ID}
        rowId={ROW_ID}
      >
        <RowProbe overlayOpen mcpActive streaming activeTool />
      </TranscriptRowStateProvider>,
    );

    const decision = registry.evaluateKeepAlive({
      sessionId: SESSION_ID,
      rows: [createRow()],
      visibleRowIds: [],
    });
    const diagnostic = decision.diagnostics.rows.find(
      (row) => row.rowId === ROW_ID,
    );

    expect(decision.protectedRowIds).toContain(ROW_ID);
    expect(diagnostic?.reasons).toEqual(
      expect.arrayContaining(["active-mcp", "active-stream", "open-overlay"]),
    );
    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })?.overlays
        ?.openPopoverIds,
    ).toContain("probe-popover");
    expect(
      registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })?.mcpApp
        ?.activeHostRequestIds,
    ).toContain("probe-host");
  });

  it("reports selected-text context menu overlay state for intersecting rows", async () => {
    const registry = createTranscriptRowStateRegistry();
    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId={SESSION_ID}
        rowId={ROW_ID}
      >
        <RowProbe />
      </TranscriptRowStateProvider>,
    );

    const textNode = screen.getByText("selectable row text").firstChild;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, "selectable".length);

    window.dispatchEvent(
      new CustomEvent(TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT, {
        detail: { open: true, ranges: [range] },
      }),
    );

    await waitFor(() => {
      const state = registry.getRowState({
        sessionId: SESSION_ID,
        rowId: ROW_ID,
      });
      expect(state?.custom?.selectedTextContextMenuOpen).toBeUndefined();
      expect(state?.overlays?.openMenuIds).toContain("selected-text");
    });
    expect(
      registry.evaluateKeepAlive({
        sessionId: SESSION_ID,
        rows: [createRow()],
        visibleRowIds: [],
      }),
    ).toMatchObject({
      protectedRowIds: [ROW_ID],
      diagnostics: {
        protectedRowCount: 1,
        protectedOffscreenRowCount: 1,
        rows: [
          expect.objectContaining({
            rowId: ROW_ID,
            reasons: ["open-overlay"],
          }),
        ],
      },
    });

    window.dispatchEvent(
      new CustomEvent(TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT, {
        detail: { open: false, ranges: [range] },
      }),
    );

    await waitFor(() => {
      const state = registry.getRowState({
        sessionId: SESSION_ID,
        rowId: ROW_ID,
      });
      expect(state?.custom?.selectedTextContextMenuOpen).toBeUndefined();
      expect(state?.overlays?.openMenuIds).toBeUndefined();
    });
    expect(
      registry.evaluateKeepAlive({
        sessionId: SESSION_ID,
        rows: [createRow()],
        visibleRowIds: [],
      }),
    ).toMatchObject({
      protectedRowIds: [],
      diagnostics: {
        protectedRowCount: 0,
        protectedOffscreenRowCount: 0,
      },
    });
  });

  it("pins the scroll anchor through the row state adapter", () => {
    const registry = createTranscriptRowStateRegistry();
    const onPinScrollAnchor = vi.fn();

    function PinProbe() {
      const { pinScrollAnchor } = useTranscriptRowStateAdapter();
      return (
        <button type="button" onClick={pinScrollAnchor}>
          pin
        </button>
      );
    }

    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId={SESSION_ID}
        rowId={ROW_ID}
        onPinScrollAnchor={onPinScrollAnchor}
      >
        <PinProbe />
      </TranscriptRowStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /pin/i }));

    expect(onPinScrollAnchor).toHaveBeenCalledTimes(1);
  });

  it("keeps pinning inert without a virtual row context", () => {
    function PinProbe() {
      const { pinScrollAnchor } = useTranscriptRowStateAdapter();
      return (
        <button type="button" onClick={pinScrollAnchor}>
          pin
        </button>
      );
    }

    // Flow (non-virtualized) transcripts render bubbles without a row context;
    // pinning must be a no-op rather than throwing.
    render(<PinProbe />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /pin/i })),
    ).not.toThrow();
  });

  it("reports image lightbox overlay state", async () => {
    const registry = createTranscriptRowStateRegistry();
    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId={SESSION_ID}
        rowId={ROW_ID}
      >
        <ClickableImage src="asset://preview.png" alt="Preview" />
      </TranscriptRowStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(
        registry.getRowState({ sessionId: SESSION_ID, rowId: ROW_ID })?.overlays
          ?.openLightboxIds,
      ).toContain("image-lightbox");
    });
  });
});
