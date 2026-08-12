import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useVirtualizer } from "@tanstack/react-virtual";

interface SessionHistoryLikeRow {
  key: string;
  title: string;
  kind: "header" | "session";
}

const ROWS: SessionHistoryLikeRow[] = Array.from(
  { length: 80 },
  (_, index) => ({
    key: `session-row-${index}`,
    title: `Session ${index}`,
    kind: index % 12 === 0 ? "header" : "session",
  }),
);

function SessionHistoryLikeVirtualList({
  rows = ROWS,
  scrollMargin = 36,
}: {
  rows?: readonly SessionHistoryLikeRow[];
  scrollMargin?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "header" ? 72 : 96),
    getItemKey: (index) => rows[index]?.key ?? index,
    measureElement: (element) =>
      (element as HTMLElement).dataset.kind === "header" ? 72 : 96,
    overscan: 5,
    scrollMargin,
    initialRect: { width: 720, height: 400 },
  });

  return (
    <div
      ref={scrollRef}
      data-testid="session-history-like-scroll"
      style={{ height: 400, overflow: "auto" }}
    >
      <div
        data-testid="session-history-like-spacer"
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-kind={row.kind}
              data-testid={`session-history-like-row-${virtualRow.index}`}
              data-virtual-key={String(virtualRow.key)}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              }}
            >
              {row.title}
            </div>
          );
        })}
      </div>
    </div>
  );
}

describe("SessionHistoryView TanStack compatibility spike", () => {
  it("supports the existing SessionHistoryView virtualizer option shape while scrolling", async () => {
    const originalResizeObserver = window.ResizeObserver;
    class FixedResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              borderBoxSize: [{ inlineSize: 720, blockSize: 400 }],
              contentBoxSize: [{ inlineSize: 720, blockSize: 400 }],
              devicePixelContentBoxSize: [{ inlineSize: 720, blockSize: 400 }],
              contentRect: {
                x: 0,
                y: 0,
                width: 720,
                height: 400,
                top: 0,
                right: 720,
                bottom: 400,
                left: 0,
                toJSON: () => ({}),
              },
            } as ResizeObserverEntry,
          ],
          this,
        );
      }

      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = FixedResizeObserver;

    try {
      render(<SessionHistoryLikeVirtualList />);
      const scroller = screen.getByTestId("session-history-like-scroll");

      act(() => {
        fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
      });

      await waitFor(() => {
        expect(
          screen.getByTestId("session-history-like-row-0"),
        ).toHaveAttribute("data-virtual-key", "session-row-0");
      });

      act(() => {
        fireEvent.scroll(scroller, { target: { scrollTop: 2400 } });
      });

      await waitFor(() => {
        expect(
          screen.getByTestId("session-history-like-row-28"),
        ).toBeInTheDocument();
      });

      expect(screen.queryByTestId("session-history-like-row-0")).toBeNull();
      expect(screen.getByTestId("session-history-like-row-28")).toHaveAttribute(
        "data-virtual-key",
        "session-row-28",
      );
    } finally {
      window.ResizeObserver = originalResizeObserver;
    }
  });
});
