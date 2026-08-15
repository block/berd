import { createRef } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import { createTranscriptRowStateRegistry } from "@/features/chat/transcript/row-state";
import type { TranscriptVirtualRowStateProviderConfig } from "@/features/chat/transcript/virtual/react/useTranscriptVirtualTimeline";
import { VirtualMessageTimeline } from "../VirtualMessageTimeline";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import {
  type MockHighlight,
  stubHighlightRegistry,
} from "@/test/highlightRegistryStub";
import {
  buildVirtualTimelineSnapshot,
  textMessage,
} from "@/features/chat/transcript/testing/virtualTimelineSnapshotFixture";

const mockState = vi.hoisted(() => ({
  // Rows outside this window are treated as unmounted by the bounded
  // controller, mirroring real windowing.
  window: { start: 0, end: Number.POSITIVE_INFINITY },
  scrollToRow: undefined as ReturnType<typeof vi.fn> | undefined,
  rowStateProvider: undefined as
    | TranscriptVirtualRowStateProviderConfig
    | undefined,
}));

vi.mock("../MessageBubble", async () => {
  const { useTranscriptRowStateAdapter } = await import(
    "@/features/chat/transcript/row-state"
  );
  return {
    MessageBubble: ({ message }: { message: Message }) => {
      const { rowState } = useTranscriptRowStateAdapter();
      return (
        <div
          data-testid={`bubble-${message.id}`}
          data-expanded={rowState?.userMessageExpandedBlocks?.["text-0"]}
        >
          {message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")}
          {rowState?.userMessageExpandedBlocks?.["text-0"]
            ? " expanded-suffix"
            : null}
        </div>
      );
    },
  };
});

vi.mock(
  "../../transcript/virtual/react/useTranscriptVirtualTimeline",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../transcript/virtual/react/useTranscriptVirtualTimeline")
      >();
    return {
      ...actual,
      useTranscriptVirtualTimeline: ({
        footerHeight,
        rows,
        loadedTranscript,
      }: {
        footerHeight: number;
        rows: readonly { rowId: string }[];
        loadedTranscript: { sessionEpoch: number; sessionId: string };
      }) => {
        const { sessionEpoch, sessionId } = loadedTranscript;
        return {
          snapshot: buildVirtualTimelineSnapshot({
            footerHeight,
            rows,
            sessionEpoch,
            sessionId,
            window: mockState.window,
          }),
          rowStateProvider: mockState.rowStateProvider,
          measureRowElement: vi.fn(),
          remeasureVisibleRowsSync: vi.fn(),
          measureOffscreenShellElement: vi.fn(),
          syncViewportFromDom: vi.fn(() => ({
            anchor: { type: "bottom" },
            bottomScrollTop: 0,
            distanceFromBottom: 0,
            footerHeight,
            nearBottom: true,
            pinnedToBottom: true,
            rowCount: rows.length,
            scrollTop: 0,
            sessionEpoch,
            sessionId,
            viewportHeight: 500,
            virtualScrollHeight: rows.length * 120 + footerHeight,
            widthScope: "w:800",
          })),
          scrollToRow: mockState.scrollToRow ?? vi.fn(() => true),
          scrollToBottom: vi.fn(() => true),
          setRowFocused: vi.fn(),
          markRowInteracted: vi.fn(),
        };
      },
    };
  },
);

let registry: Map<string, MockHighlight>;
const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  registry = stubHighlightRegistry();
  mockState.scrollToRow = vi.fn(() => true);
  mockState.rowStateProvider = undefined;
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  scrollIntoViewMock.mockClear();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const MESSAGES: Message[] = [
  textMessage("m1", "user", "needle one"),
  textMessage("m2", "assistant", "needle two"),
  textMessage("m3", "user", "needle three"),
  textMessage("m4", "assistant", "needle four"),
];

function renderTimeline() {
  const backendRef = createRef<TranscriptSearchBackend | null>();
  const view = renderWithProviders(
    <VirtualMessageTimeline
      sessionId="session-1"
      messages={MESSAGES}
      searchBackendRef={backendRef}
    />,
  );
  return { backendRef, view };
}

describe("VirtualMessageTimeline indexed search", () => {
  it("invalidates harvested text when durable disclosure state changes", async () => {
    const rowStateRegistry = createTranscriptRowStateRegistry();
    mockState.rowStateProvider = {
      registry: rowStateRegistry,
      sessionId: "session-1",
      sessionEpoch: 1,
      onRowStateChange: vi.fn(),
    };
    mockState.window = { start: 2, end: Number.POSITIVE_INFINITY };

    const { backendRef } = renderTimeline();
    act(() => backendRef.current?.setQuery("expanded-suffix"));
    await waitFor(() => {
      expect(backendRef.current?.getSnapshot().indexing).toBe(false);
      expect(backendRef.current?.getSnapshot().total).toBe(0);
    });

    act(() => {
      rowStateRegistry.updateRowState({
        sessionId: "session-1",
        sessionEpoch: 1,
        rowId: "message:m1",
        updater: (current) => ({
          ...current,
          userMessageExpandedBlocks: { "text-0": true },
        }),
      });
    });

    await waitFor(() => {
      expect(backendRef.current?.getSnapshot().indexing).toBe(false);
      expect(backendRef.current?.getSnapshot().total).toBe(1);
    });
  });

  it("counts unmounted rows via offscreen harvest while windowing stays on", async () => {
    // Window out the first rows (date separator + first message).
    mockState.window = { start: 2, end: Number.POSITIVE_INFINITY };

    const { backendRef } = renderTimeline();
    const backend = backendRef.current;
    expect(backend).not.toBeNull();

    act(() => {
      backend?.setQuery("needle");
    });

    // Mounted rows answer synchronously; the windowed-out rest is indexing,
    // so the anchor is deferred until the index converges.
    const initial = backend?.getSnapshot();
    expect(initial?.total).toBeGreaterThan(0);
    expect(initial?.total).toBeLessThan(MESSAGES.length);
    expect(initial?.indexing).toBe(true);
    expect(initial?.activeOrdinal).toBe(-1);

    // Searchable rows remain rendered while harvesting, but the host contains
    // any batch height without a fixed translateY hoist.
    const harvestHost = screen.getByTestId("transcript-search-harvest-host");
    expect(harvestHost.style.height).toBe("0px");
    expect(harvestHost.style.overflow).toBe("clip");
    expect(harvestHost.style.transform).toBe("");
    expect(harvestHost.style.visibility).toBe("");
    expect(harvestHost.style.display).toBe("");

    // The harvest host renders the missing rows offscreen, the count
    // converges to the full transcript, and the anchor lands on the
    // transcript-order FIRST match — not whatever was mounted.
    await waitFor(
      () => {
        const snapshot = backend?.getSnapshot();
        expect(snapshot?.total).toBe(MESSAGES.length);
        expect(snapshot?.indexing).toBe(false);
        expect(snapshot?.activeOrdinal).toBe(0);
      },
      { timeout: 4000 },
    );

    // Windowing was never suspended.
    expect(screen.getByTestId("virtual-message-timeline-list")).toHaveAttribute(
      "data-virtual-unmounting",
      "enabled",
    );

    // Highlights paint only for mounted rows.
    const painted = registry.get("chat-search-match");
    expect(painted).toBeDefined();
    expect(painted?.ranges.length).toBeLessThan(MESSAGES.length);
    expect(painted?.ranges.length).toBeGreaterThan(0);
  });

  it("anchors to an unmounted first match by scrolling its row into the window", async () => {
    mockState.window = { start: 2, end: Number.POSITIVE_INFINITY };

    const { backendRef, view } = renderTimeline();
    const backend = backendRef.current;

    act(() => {
      backend?.setQuery("needle");
    });
    await waitFor(
      () => {
        expect(backend?.getSnapshot().total).toBe(MESSAGES.length);
      },
      { timeout: 4000 },
    );

    // Ordinal 0 lives in the windowed-out first message; the auto-anchor must
    // ask the virtualizer to bring the row in.
    await waitFor(() => {
      expect(mockState.scrollToRow).toHaveBeenCalled();
    });

    // Simulate the virtualizer responding: the window now includes the row.
    mockState.window = { start: 0, end: Number.POSITIVE_INFINITY };
    view.rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={MESSAGES}
        searchBackendRef={backendRef}
      />,
    );

    await waitFor(
      () => {
        expect(backend?.getSnapshot().activeOrdinal).toBe(0);
      },
      { timeout: 4000 },
    );
    // All rows mounted now, so every match paints.
    await waitFor(() => {
      expect(registry.get("chat-search-match")?.ranges).toHaveLength(
        MESSAGES.length,
      );
    });
  });

  it("clears paint and counts on clear()", async () => {
    mockState.window = { start: 0, end: Number.POSITIVE_INFINITY };

    const { backendRef } = renderTimeline();
    const backend = backendRef.current;

    act(() => {
      backend?.setQuery("needle");
    });
    await waitFor(() => {
      expect(backend?.getSnapshot().total).toBe(MESSAGES.length);
    });

    act(() => {
      backend?.clear();
    });

    expect(backend?.getSnapshot().total).toBe(0);
    expect(registry.get("chat-search-match")?.ranges ?? []).toHaveLength(0);
  });
});
