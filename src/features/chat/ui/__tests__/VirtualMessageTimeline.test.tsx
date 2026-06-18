import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import type { RunCommandOptions } from "@/shared/ui/ai-elements/runnable-code-block";
import {
  TRANSCRIPT_DIAGNOSTICS_EVENT,
  validateTranscriptDiagnostics,
  type TranscriptDiagnostics,
} from "../../transcript/diagnostics";
import type { TranscriptRowDescriptor } from "../../transcript/projection";
import {
  VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT,
  VirtualMessageTimeline,
  type VirtualMessageTimelineDiagnostics,
} from "../VirtualMessageTimeline";
import { getVirtualTranscriptRowSpacingBlockSize } from "../virtualTranscriptRowSpacing";

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function triggerResizeObservers() {
  act(() => {
    for (const callback of resizeObserverCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });
}

vi.mock("../MessageBubble", async () => {
  const rowState = await vi.importActual<
    typeof import("@/features/chat/transcript/row-state")
  >("@/features/chat/transcript/row-state");

  return {
    MessageBubble: ({
      message,
      isStreaming,
      contentOverride,
      fragmentRole,
      actionsAlwaysVisible,
      showJumpToResponseStartHint,
      onEditProject,
      onRunShellCommand,
    }: {
      message: Message;
      isStreaming?: boolean;
      contentOverride?: readonly Message["content"][number][];
      fragmentRole?: string;
      actionsAlwaysVisible?: boolean;
      showJumpToResponseStartHint?: boolean;
      onEditProject?: (projectId: string) => void;
      onRunShellCommand?: (
        command: string,
        options?: RunCommandOptions,
      ) => void;
    }) => {
      const rowRootAttributes = rowState.useTranscriptRowRootAdapter();
      const content = contentOverride ?? message.content;
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const heightMatch = /\[height:(\d+)\]/.exec(text);
      const isPending = text.includes("[pending]");

      return (
        <div
          data-testid={`bubble-${message.id}`}
          data-streaming={isStreaming ? "true" : "false"}
          data-fragment-role={fragmentRole ?? "whole"}
          data-actions-always-visible={actionsAlwaysVisible ? "true" : "false"}
          data-response-start-hint={
            showJumpToResponseStartHint ? "true" : "false"
          }
          data-mock-row-height={heightMatch?.[1] ?? "144"}
          tabIndex={-1}
          {...rowRootAttributes}
          {...(isPending
            ? {
                "data-virtual-row-layout-pending": "image-loading",
                "data-virtual-row-reserved-block-size": "320",
              }
            : {})}
        >
          {text}
          {onEditProject ? (
            <button type="button" onClick={() => onEditProject("project-7")}>
              Edit project probe
            </button>
          ) : null}
          {onRunShellCommand ? (
            <button
              type="button"
              onClick={() =>
                onRunShellCommand("pnpm test", { newTerminal: true })
              }
            >
              Run command probe
            </button>
          ) : null}
        </div>
      );
    },
  };
});

beforeEach(() => {
  resizeObserverCallbacks.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function textMessage(
  id: string,
  role: Message["role"],
  text: string,
  metadata: Message["metadata"] = { userVisible: true },
): Message {
  return {
    id,
    role,
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text }],
    metadata,
  };
}

function activeToolMessage(id: string): Message {
  return {
    id,
    role: "assistant",
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [
      {
        type: "toolRequest",
        id: "tool-1",
        name: "scan",
        arguments: {},
        status: "in_progress",
        startedAt: 100,
      },
    ],
    metadata: { userVisible: true },
  };
}

function longText(label: string, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `${label} line ${String(index).padStart(3, "0")}`,
  ).join("\n");
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

function mockTranscriptElementMeasurements() {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function getMockRect(this: HTMLElement) {
      if (this.hasAttribute("data-virtual-row-offscreen-shell-id")) {
        return createDomRect(
          readNumericAttribute(
            this,
            "data-virtual-row-shell-estimated-block-size",
            144,
          ) +
            readNumericAttribute(
              this,
              "data-virtual-row-shell-spacing-block-size",
              0,
            ),
        );
      }

      if (this.hasAttribute("data-virtual-row-offscreen-real-id")) {
        const measuredDescendant = this.querySelector("[data-mock-row-height]");
        return createDomRect(
          readNumericAttribute(
            measuredDescendant,
            "data-mock-row-height",
            144,
          ) + readMockPaddingBlockSize(this),
        );
      }

      if (
        this.getAttribute("data-testid")?.startsWith("virtual-transcript-row-")
      ) {
        const measuredDescendant = this.querySelector("[data-mock-row-height]");
        return createDomRect(
          readNumericAttribute(measuredDescendant, "data-mock-row-height", 144),
        );
      }

      return createDomRect(0);
    });
}

function readNumericAttribute(
  element: Element | null,
  attribute: string,
  fallback: number,
): number {
  const value = element?.getAttribute(attribute);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readMockPaddingBlockSize(element: HTMLElement): number {
  if (element.classList.contains("pt-6")) {
    return 24;
  }

  if (element.classList.contains("pt-4")) {
    return 16;
  }

  return 0;
}

function createDomRect(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function setScrollMetrics(
  element: HTMLElement,
  {
    scrollTop,
    scrollHeight = 1000,
    clientHeight = 500,
    clientWidth = 800,
  }: {
    scrollTop: number;
    scrollHeight?: number;
    clientHeight?: number;
    clientWidth?: number;
  },
) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
}

function attachScrollTo(element: HTMLElement) {
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === "number") {
      element.scrollTop = options.top;
    }
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

function mockRequestAnimationFrame() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return {
    run(now: number) {
      const nextCallback = callbacks.entries().next().value;
      if (!nextCallback) {
        return false;
      }
      const [frameId, callback] = nextCallback;
      callbacks.delete(frameId);
      act(() => callback(now));
      return true;
    },
    runAll(now: number) {
      for (
        let frameCount = 0;
        frameCount < 20 && this.run(now);
        frameCount += 1
      ) {
        // Flush all queued requestAnimationFrame work for resize tests.
      }
    },
  };
}

function latestTimelineDiagnostics(
  diagnosticsSpy: ReturnType<typeof vi.fn>,
): VirtualMessageTimelineDiagnostics | undefined {
  return diagnosticsSpy.mock.calls.at(-1)?.[0] as
    | VirtualMessageTimelineDiagnostics
    | undefined;
}

describe("VirtualMessageTimeline", () => {
  it("forwards edit-project actions to virtual row bubbles", async () => {
    const onEditProject = vi.fn();
    const message: Message = {
      id: "system-1",
      role: "system",
      created: Date.UTC(2026, 5, 4, 12, 0, 0),
      content: [
        {
          type: "systemNotification",
          notificationType: "error",
          text: "Project folder is missing",
          action: { type: "editProject", projectId: "project-7" },
        },
      ],
      metadata: { userVisible: true },
    };

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[message]}
        onEditProject={onEditProject}
      />,
    );

    fireEvent.click(await screen.findByText("Edit project probe"));

    expect(onEditProject).toHaveBeenCalledWith("project-7");
  });

  it("preserves runnable command options through virtual row bubbles", async () => {
    const onRunShellCommand = vi.fn();

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          textMessage("assistant-1", "assistant", "```bash\npnpm test\n```"),
        ]}
        onRunShellCommand={onRunShellCommand}
      />,
    );

    fireEvent.click(await screen.findByText("Run command probe"));

    expect(onRunShellCommand).toHaveBeenCalledWith("pnpm test", {
      newTerminal: true,
    });
  });

  it("uses the shared transcript scroller chrome", () => {
    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[textMessage("user-1", "user", "Question")]}
      />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");

    expect(scroller).toHaveClass("scrollbar-subtle", "overscroll-contain");
    expect(scroller).not.toHaveClass("scrollbar-none");
  });

  it("renders assistant fragment rows and keeps mixed content on whole-message fallback", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    // Three paragraphs of 22 lines each (66 content lines + 2 blank separators = 68 lines)
    // satisfies ASSISTANT_FRAGMENT_MIN_LINE_COUNT (60) and produces 3 block-level fragments.
    const fragmented = textMessage(
      "fragmented",
      "assistant",
      multiParagraphText("fragmented assistant", 3, 22),
    );
    const mixed: Message = {
      ...textMessage(
        "mixed",
        "assistant",
        multiParagraphText("mixed assistant", 3, 22),
      ),
      content: [
        { type: "text", text: multiParagraphText("mixed assistant", 3, 22) },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "write_file",
          arguments: { path: "README.md" },
          status: "completed",
        },
      ],
    };

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[fragmented, mixed]}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const firstFragment = await screen.findByTestId(
      "virtual-transcript-row-message:fragmented:block-0",
    );
    const middleFragment = screen.getByTestId(
      "virtual-transcript-row-message:fragmented:block-1",
    );
    const lastFragment = screen.getByTestId(
      "virtual-transcript-row-message:fragmented:block-2",
    );
    const fallbackRow = screen.getByTestId(
      "virtual-transcript-row-message:mixed",
    );

    expect(firstFragment).toHaveAttribute(
      "data-virtual-row-kind",
      "assistant-content-fragment",
    );
    expect(firstFragment).toHaveAttribute(
      "data-transcript-message-id",
      "fragmented",
    );
    expect(firstFragment.style.left).toBe("0px");
    expect(firstFragment.style.right).toBe("0px");
    expect(middleFragment).not.toHaveAttribute("data-transcript-message-id");
    expect(lastFragment).toHaveAttribute(
      "data-virtual-row-fragment-role",
      "end",
    );
    // Non-code-continuation fragments are spaced blocks, not zero-spaced continuations.
    expect(middleFragment).toHaveClass("pt-4");
    expect(lastFragment).toHaveClass("pt-4");
    expect(fallbackRow).toHaveAttribute("data-virtual-row-kind", "message");
    expect(fallbackRow).toHaveAttribute("data-transcript-message-id", "mixed");

    expect(
      screen
        .getAllByTestId("bubble-fragmented")
        .map((element) => element.getAttribute("data-fragment-role")),
    ).toEqual(["start", "middle", "end"]);
    expect(screen.getByTestId("bubble-mixed")).toHaveAttribute(
      "data-fragment-role",
      "whole",
    );

    const list = screen.getByTestId("virtual-message-timeline-list");
    expect(list).toHaveAttribute("data-virtual-fragment-rows", "3");
    expect(list).toHaveAttribute(
      "data-virtual-whole-message-fallback-rows",
      "1",
    );

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fragmentRowCount: 3,
          completedFragmentRowCount: 3,
          wholeMessageFallbackRowCount: 1,
          pr928WholeRowSplitProofs: 1,
        }),
      ),
    );
  });

  it("keeps standalone date rows from adding extra spacing before the first message", async () => {
    const firstDayMessage = textMessage("first-day", "user", "First day");
    const nextDayMessage = {
      ...textMessage("next-day", "assistant", "Next day"),
      created: Date.UTC(2026, 5, 5, 12, 0, 0),
    };

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[firstDayMessage, nextDayMessage]}
      />,
    );

    const firstDateRow = await screen.findByTestId(
      "virtual-transcript-row-date:2026-06-04:before:first-day",
    );
    const firstMessageRow = screen.getByTestId(
      "virtual-transcript-row-message:first-day",
    );
    const nextDateRow = screen.getByTestId(
      "virtual-transcript-row-date:2026-06-05:before:next-day",
    );
    const nextMessageRow = screen.getByTestId(
      "virtual-transcript-row-message:next-day",
    );

    expect(firstDateRow).toHaveClass("pt-0");
    expect(firstMessageRow).toHaveClass("pt-0");
    expect(nextDateRow).toHaveClass("pt-4");
    expect(nextMessageRow).toHaveClass("pt-0");
  });

  it("uses visible row spacing rules for offscreen shell measurement spacing", () => {
    const normalRow = {
      kind: "message",
    } as TranscriptRowDescriptor;
    // Only code-continuation chunks (isCodeContinuationChunk === true) are
    // zero-spaced. Regular fragment middle/end rows get standard block spacing.
    const codeFragmentContinuationRow = {
      kind: "assistant-content-fragment",
      fragment: {
        role: "middle",
        isCodeContinuationChunk: true,
        startsWithHeading: false,
      },
    } as TranscriptRowDescriptor;
    const textFragmentMiddleRow = {
      kind: "assistant-content-fragment",
      fragment: {
        role: "middle",
        isCodeContinuationChunk: false,
        startsWithHeading: false,
      },
    } as TranscriptRowDescriptor;

    expect(
      getVirtualTranscriptRowSpacingBlockSize({
        row: normalRow,
        index: 3,
        previousRowKind: "date-separator",
      }),
    ).toBe(0);
    expect(
      getVirtualTranscriptRowSpacingBlockSize({
        row: codeFragmentContinuationRow,
        index: 3,
        previousRowKind: "assistant-content-fragment",
      }),
    ).toBe(0);
    expect(
      getVirtualTranscriptRowSpacingBlockSize({
        row: textFragmentMiddleRow,
        index: 3,
        previousRowKind: "assistant-content-fragment",
      }),
    ).toBe(16);
    expect(
      getVirtualTranscriptRowSpacingBlockSize({
        row: normalRow,
        index: 3,
        previousRowKind: "message",
      }),
    ).toBe(16);
  });

  it("includes row spacing in offscreen real measurement rows", async () => {
    mockTranscriptElementMeasurements();
    const messages = Array.from({ length: 80 }, (_, index) => ({
      ...textMessage(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Message ${index}`,
      ),
      created:
        index < 40
          ? Date.UTC(2026, 5, 4, 12, 0, 0)
          : Date.UTC(2026, 5, 5, 12, 0, 0),
    }));

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId="message-79"
      />,
    );

    const offscreenRealHost = await screen.findByTestId(
      "virtual-offscreen-real-measurement-host",
    );
    await waitFor(() => {
      const offscreenRealRows = Array.from(
        offscreenRealHost.querySelectorAll<HTMLElement>(
          "[data-virtual-row-offscreen-real-id]",
        ),
      );
      expect(offscreenRealRows.length).toBeGreaterThan(0);
      const spacedRows = offscreenRealRows.filter(
        (row) =>
          row.classList.contains("pt-4") || row.classList.contains("pt-6"),
      );
      expect(spacedRows.length).toBeGreaterThan(0);
      for (const row of offscreenRealRows) {
        expect(row).not.toHaveClass("mt-4");
        expect(row).not.toHaveClass("mt-6");
      }
    });
  });

  it("applies footer clearance to the virtual list height without extra padding", async () => {
    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[textMessage("assistant-1", "assistant", "Answer")]}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    const list = screen.getByTestId("virtual-message-timeline-list");
    const history = screen.getByTestId("virtual-message-timeline-history");
    await waitFor(() => expect(history).toHaveStyle({ height: "198px" }));
    expect(list).toHaveStyle({ paddingBottom: "0px" });
  });

  it("keeps long assistant fragment rows in bounded virtual mode", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const messages = [
      ...Array.from({ length: 160 }, (_, index) =>
        textMessage(
          `message-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `Message ${index}`,
        ),
      ),
      textMessage(
        "fragmented",
        "assistant",
        multiParagraphText("fragmented", 3, 22),
      ),
    ];

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const fragmentedRow = await screen.findByTestId(
      "virtual-transcript-row-message:fragmented:block-2",
    );
    expect(fragmentedRow).toHaveAttribute(
      "data-virtual-row-kind",
      "assistant-content-fragment",
    );
    expect(fragmentedRow.style.top).toBe(
      `${fragmentedRow.getAttribute("data-virtual-row-virtual-start")}px`,
    );
    expect(fragmentedRow.style.transform).toBe("");
    expect(screen.queryByTestId("bubble-message-0")).not.toBeInTheDocument();

    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-render-mode",
        "bounded-controller",
      ),
    );
    expect(list).toHaveAttribute("data-virtual-unmounting", "enabled");
    expect(list).toHaveAttribute("data-virtual-fallback-reasons", "");
    expect(list).toHaveAttribute("data-virtual-fragment-rows", "3");
    expect(Number(list.getAttribute("data-virtual-total-rows"))).toBe(164);
    expect(
      Number(list.getAttribute("data-virtual-range-mounted-rows")),
    ).toBeLessThan(164);
    expect(Number(list.getAttribute("data-virtual-mounted-rows"))).toBeLessThan(
      164,
    );

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "bounded-controller",
          fragmentRowCount: 3,
          virtualUnmountingEnabled: true,
          fallbackReasons: [],
        }),
      ),
    );
  });

  it("renders an over-tall streaming assistant message as a live flow tail", async () => {
    mockTranscriptElementMeasurements();
    const initialMessages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Short streaming answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={initialMessages}
        streamingMessageId="assistant-1"
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          initialMessages[0],
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("streaming fragment", 120)}\n[height:650]`,
          ),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    const streamingRow = await screen.findByTestId(
      "virtual-transcript-row-message:assistant-1",
    );
    expect(streamingRow).toHaveAttribute("data-virtual-row-kind", "message");
    expect(streamingRow).toHaveAttribute(
      "data-virtual-row-anchor-priority",
      "streaming",
    );
    const liveTail = screen.getByTestId("virtual-message-timeline-live-tail");
    expect(liveTail).toContainElement(streamingRow);
    expect(streamingRow).not.toHaveAttribute("data-virtual-row-protected");
    expect(screen.getByTestId("bubble-assistant-1")).toHaveAttribute(
      "data-streaming",
      "true",
    );
    expect(screen.getByTestId("virtual-message-timeline-list")).toHaveAttribute(
      "data-virtual-fragment-rows",
      "0",
    );
    expect(screen.getByTestId("virtual-message-timeline-list")).toHaveAttribute(
      "data-virtual-live-tail-rows",
      "3",
    );
    await waitFor(() => expect(scroller.scrollTop).toBe(4700));
    expect(
      screen.queryByRole("button", { name: "Jump to response start" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          initialMessages[0],
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("streaming fragment", 125)}\n[height:700]`,
          ),
        ]}
        streamingMessageId="assistant-1"
      />,
    );
    expect(scroller.scrollTop).toBe(4700);

    fireEvent.wheel(scroller, { deltaY: -120 });
    setScrollMetrics(scroller, {
      scrollTop: 120,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          initialMessages[0],
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("streaming fragment", 125)}\n[height:700]`,
          ),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    expect(scroller.scrollTop).toBe(120);

    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));

    expect(scroller.scrollTop).toBe(4700);
  });

  it("falls back to the mounted live tail element for active streaming scroll targets", async () => {
    mockTranscriptElementMeasurements();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    try {
      renderWithProviders(
        <VirtualMessageTimeline
          sessionId="session-1"
          messages={[
            textMessage("user-1", "user", "Question"),
            textMessage(
              "assistant-1",
              "assistant",
              `${longText("streaming target", 120)}\n[height:650]`,
            ),
          ]}
          streamingMessageId="assistant-1"
          scrollTargetMessageId="assistant-1"
        />,
      );

      const streamingRow = await screen.findByTestId(
        "virtual-transcript-row-message:assistant-1",
      );
      expect(
        screen.getByTestId("virtual-message-timeline-live-tail"),
      ).toContainElement(streamingRow);

      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: "auto",
          block: "center",
          inline: "nearest",
        }),
      );
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          writable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (
          Element.prototype as {
            scrollIntoView?: Element["scrollIntoView"];
          }
        ).scrollIntoView;
      }
    }
  });

  it("shows the response-start hint when a completed assistant appears without an observed streaming transition", async () => {
    mockTranscriptElementMeasurements();
    const animationFrame = mockRequestAnimationFrame();
    const userMessage = textMessage("user-1", "user", "Question");
    const assistantMessage = textMessage(
      "assistant-1",
      "assistant",
      `${longText("Answer", 80)}\n[height:700]`,
    );

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={[userMessage]} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 1400,
      clientHeight: 500,
    });

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[userMessage, assistantMessage]}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("bubble-assistant-1").length,
      ).toBeGreaterThan(0),
    );
    animationFrame.runAll(1000);

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("bubble-assistant-1")
          .some(
            (element) =>
              element.getAttribute("data-response-start-hint") === "true",
          ),
      ).toBe(true),
    );
  });

  it("resumes following a live flow tail when the user scrolls down to latest", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage(
        "assistant-1",
        "assistant",
        `${longText("streaming fragment", 120)}\n[height:650]`,
      ),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId="assistant-1"
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    const scrollTo = attachScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 100,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.wheel(scroller, { deltaY: 120 });

    expect(scroller.scrollTop).toBe(4700);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    scrollTo.mockClear();
    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5200,
      clientHeight: 300,
    });

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          messages[0],
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("streaming fragment", 130)}\n[height:720]`,
          ),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(4900));
    expect(scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );

    scrollTo.mockClear();
    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          messages[0],
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("streaming fragment", 130)}\n[height:720]`,
          ),
        ]}
        streamingMessageId={null}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(4900));
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("does not auto-scroll again for the same latest user message after detaching", async () => {
    mockTranscriptElementMeasurements();
    const latestUser = textMessage("user-latest", "user", "Follow up");
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("history", 80)}\n[height:900]`,
          ),
          latestUser,
        ]}
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });

    fireEvent.wheel(scroller, { deltaY: -300 });
    setScrollMetrics(scroller, {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Jump to latest" }),
      ).toBeInTheDocument(),
    );
    const detachedScrollTop = scroller.scrollTop;
    expect(detachedScrollTop).toBeLessThan(700);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          textMessage(
            "assistant-1",
            "assistant",
            `${longText("history", 82)}\n[height:920]`,
          ),
          latestUser,
        ]}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(detachedScrollTop));
  });

  it("keeps pinned users attached across virtual timeline resizes", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    const scrollTo = attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    triggerResizeObservers();
    animationFrame.runAll(1000);

    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThanOrEqual(500));
    expect(scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(
        "virtual-transcript-row-date:2026-06-04:before:user-1",
      ),
    ).not.toHaveStyle({ transition: "height 1500ms linear" });
  });

  it("keeps detached users stable across virtual timeline resizes", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    const scrollTo = attachScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    triggerResizeObservers();
    animationFrame.runAll(1000);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(300);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("keeps Jump hidden when detached with only small footer clearance below latest", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");

    setScrollMetrics(scroller, {
      scrollTop: 430,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("renders a bounded controller range for ordinary rows", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const transcriptDiagnosticsSpy = vi.fn();
    const diagnosticEvents: VirtualMessageTimelineDiagnostics[] = [];
    const transcriptDiagnosticEvents: TranscriptDiagnostics[] = [];
    const handleDiagnosticsEvent = (event: Event) => {
      diagnosticEvents.push(
        (event as CustomEvent<VirtualMessageTimelineDiagnostics>).detail,
      );
    };
    const handleTranscriptDiagnosticsEvent = (event: Event) => {
      transcriptDiagnosticEvents.push(
        (event as CustomEvent<TranscriptDiagnostics>).detail,
      );
    };
    window.addEventListener(
      VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT,
      handleDiagnosticsEvent,
    );
    window.addEventListener(
      TRANSCRIPT_DIAGNOSTICS_EVENT,
      handleTranscriptDiagnosticsEvent,
    );
    const messages = Array.from({ length: 80 }, (_, index) => ({
      ...textMessage(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Message ${index}`,
      ),
      created:
        index < 40
          ? Date.UTC(2026, 5, 4, 12, 0, 0)
          : Date.UTC(2026, 5, 5, 12, 0, 0),
    }));

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId="message-79"
        onDiagnostics={diagnosticsSpy}
        onTranscriptDiagnostics={transcriptDiagnosticsSpy}
      />,
    );

    expect(screen.getByTestId("virtual-message-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("bubble-message-79")).toHaveTextContent(
      "Message 79",
    );
    expect(screen.getByTestId("bubble-message-79")).toHaveAttribute(
      "data-streaming",
      "true",
    );
    expect(screen.getByTestId("bubble-message-79")).toHaveAttribute(
      "data-virtual-row-state",
      "enabled",
    );
    expect(screen.queryByTestId("bubble-message-0")).not.toBeInTheDocument();

    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-render-mode",
        "bounded-controller",
      ),
    );
    expect(list).toHaveAttribute("data-virtual-engine", "tanstack");
    expect(list).toHaveAttribute("data-virtual-unmounting", "enabled");
    expect(list).toHaveAttribute("data-virtual-total-rows", "82");
    const mountedRows = Number(list.getAttribute("data-virtual-mounted-rows"));
    const virtualRangeMountedRows = Number(
      list.getAttribute("data-virtual-range-mounted-rows"),
    );
    const offscreenShellMountedRows = Number(
      list.getAttribute("data-virtual-offscreen-shell-mounted-rows"),
    );
    const offscreenRealMountedRows = Number(
      list.getAttribute("data-virtual-offscreen-real-mounted-rows"),
    );
    const liveTailRows = Number(
      list.getAttribute("data-virtual-live-tail-rows"),
    );
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(82);
    expect(mountedRows).toBe(
      virtualRangeMountedRows +
        offscreenRealMountedRows +
        offscreenShellMountedRows +
        liveTailRows,
    );

    const assistantRow = screen.getByTestId(
      "virtual-transcript-row-message:message-79",
    );
    expect(assistantRow).toHaveAttribute(
      "data-virtual-row-measurement-policy",
      "measure-shell",
    );
    expect(assistantRow).toHaveAttribute(
      "data-virtual-row-shell-status",
      "ready",
    );
    const postDateShellRow = await screen.findByTestId(
      "virtual-transcript-shell-row-message:message-40",
    );
    expect(postDateShellRow).toHaveAttribute(
      "data-virtual-row-shell-spacing-block-size",
      "0",
    );

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          renderer: "virtual-message-timeline",
          engineKind: "tanstack",
          mode: "bounded-controller",
          sessionId: "session-1",
          totalRows: 82,
          offscreenRealMountedRows,
          offscreenShellMountedRows,
          virtualUnmountingEnabled: true,
        }),
      ),
    );
    expect(diagnosticEvents.at(-1)).toMatchObject({
      renderer: "virtual-message-timeline",
      engineKind: "tanstack",
      mode: "bounded-controller",
      virtualUnmountingEnabled: true,
    });
    await waitFor(() =>
      expect(
        diagnosticEvents.at(-1)?.measurement.acceptedOffscreenShellMeasurements,
      ).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(
        diagnosticEvents.at(-1)?.measurement.acceptedOffscreenRealMeasurements,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.getByTestId("virtual-offscreen-real-measurement-host"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByTestId("virtual-offscreen-measurement-host"),
    ).toHaveAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(transcriptDiagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeKind: "production-virtual-message-timeline",
          rendererMode: "virtual",
          sessionId: "session-1",
          totalRows: 82,
          virtualUnmountingEnabled: true,
        }),
      ),
    );
    expect(
      validateTranscriptDiagnostics(transcriptDiagnosticEvents.at(-1)).errors,
    ).toEqual([]);
    const sharedWindowDiagnostics = window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__;
    expect(sharedWindowDiagnostics).toMatchObject({
      bridgeKind: "production-virtual-message-timeline",
      rendererMode: "virtual",
      mountedRows: expect.any(Number),
      totalRows: 82,
      scrollCorrectionCount: expect.any(Number),
    });
    expect(sharedWindowDiagnostics?.mountedRows).toBeGreaterThan(0);
    expect(sharedWindowDiagnostics?.mountedRows).toBeLessThan(82);

    window.removeEventListener(
      VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT,
      handleDiagnosticsEvent,
    );
    window.removeEventListener(
      TRANSCRIPT_DIAGNOSTICS_EVENT,
      handleTranscriptDiagnosticsEvent,
    );
  });

  it("keeps offscreen shell measurement out of visible search text and duplicate live logs", async () => {
    mockTranscriptElementMeasurements();
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );

    expect(await screen.findByText("Message 79")).toBeInTheDocument();
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();

    const offscreenHost = await screen.findByTestId(
      "virtual-offscreen-measurement-host",
    );
    expect(offscreenHost).toHaveAttribute("aria-hidden", "true");
    expect(offscreenHost).not.toHaveTextContent("Message 0");
    expect(offscreenHost.textContent).toBe("");
    expect(screen.getAllByRole("log")).toHaveLength(1);
  });

  it("keeps estimate-only rows out of the offscreen shell measurement host", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const messages = [
      activeToolMessage("active-tool"),
      ...Array.from({ length: 80 }, (_, index) =>
        textMessage(`message-${index}`, "assistant", `Message ${index}`),
      ),
    ];

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute("data-virtual-protected-rows", "1"),
    );

    const activeToolRow = await screen.findByTestId(
      "virtual-transcript-row-message:active-tool:tool-chain",
    );
    expect(activeToolRow).toHaveAttribute(
      "data-virtual-row-measurement-policy",
      "estimate-only",
    );
    expect(activeToolRow).toHaveAttribute(
      "data-virtual-row-shell-status",
      "blocked",
    );
    expect(activeToolRow).toHaveAttribute("data-virtual-row-protected", "true");
    expect(activeToolRow).toHaveAttribute("data-virtual-row-visible", "false");

    const offscreenHost = await screen.findByTestId(
      "virtual-offscreen-measurement-host",
    );
    expect(
      offscreenHost.querySelector(
        '[data-virtual-row-offscreen-shell-id="message:active-tool:tool-chain"]',
      ),
    ).toBeNull();
    expect(
      screen
        .queryByTestId("virtual-offscreen-real-measurement-host")
        ?.querySelector(
          '[data-virtual-row-offscreen-real-id="message:active-tool:tool-chain"]',
        ) ?? null,
    ).toBeNull();
  });

  it("unions row-state protected rows into the rendered range", async () => {
    const diagnosticsSpy = vi.fn();
    const messages = [
      textMessage("protected", "assistant", "Protected stream", {
        userVisible: true,
        completionStatus: "inProgress",
      }),
      ...Array.from({ length: 80 }, (_, index) =>
        textMessage(`message-${index}`, "user", `Message ${index}`),
      ),
    ];

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const protectedRow = await screen.findByTestId(
      "virtual-transcript-row-message:protected",
    );
    expect(protectedRow).toHaveAttribute("data-virtual-row-protected", "true");
    expect(protectedRow).toHaveAttribute("data-virtual-row-visible", "false");

    const list = screen.getByTestId("virtual-message-timeline-list");
    expect(list).toHaveAttribute(
      "data-virtual-render-mode",
      "bounded-controller",
    );
    expect(list).toHaveAttribute("data-virtual-protected-rows", "1");
    expect(list).toHaveAttribute("data-virtual-protected-offscreen-rows", "1");

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "bounded-controller",
          protectedRows: 1,
          protectedOffscreenRows: 1,
        }),
      ),
    );
  });

  it("updates keepalive diagnostics when a virtual row adapter reports focus", async () => {
    const diagnosticsSpy = vi.fn();
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const focusedBubble = await screen.findByTestId("bubble-message-79");
    fireEvent.focus(focusedBubble);

    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() => {
      expect(list).toHaveAttribute("data-virtual-protected-rows", "1");
    });
    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          protectedRows: 1,
        }),
      ),
    );
  });

  it("does not rescan measurement cache on scroll-only snapshots", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(
        latestTimelineDiagnostics(diagnosticsSpy)?.measurement.cacheWrites,
      ).toBeGreaterThan(0),
    );
    const cacheMissesBefore =
      latestTimelineDiagnostics(diagnosticsSpy)?.measurement.cacheMisses ?? 0;
    const scroller = screen.getByTestId("message-timeline-scroll");

    fireEvent.scroll(scroller);
    await Promise.resolve();

    expect(
      latestTimelineDiagnostics(diagnosticsSpy)?.measurement.cacheMisses,
    ).toBe(cacheMissesBefore);
  });

  it("classifies initial tail positioning outside delayed layout correction p95", async () => {
    const diagnosticsSpy = vi.fn();
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(
        latestTimelineDiagnostics(diagnosticsSpy)?.controller
          .lastCorrectionDeltaPx,
      ).toBeGreaterThan(0),
    );
    expect(latestTimelineDiagnostics(diagnosticsSpy)).toMatchObject({
      scrollCorrectionP95Px: 0,
    });
  });

  it("classifies first projection after session switch outside descriptor churn", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const primaryMessages = Array.from({ length: 40 }, (_, index) =>
      textMessage(`primary-${index}`, "assistant", `Primary ${index}`),
    );
    const secondaryMessages = Array.from({ length: 20 }, (_, index) =>
      textMessage(`secondary-${index}`, "assistant", `Secondary ${index}`),
    );

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-primary"
        messages={primaryMessages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(latestTimelineDiagnostics(diagnosticsSpy)).toMatchObject({
        sessionId: "session-primary",
        descriptorChurnPercent: 0,
      }),
    );

    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={secondaryMessages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(latestTimelineDiagnostics(diagnosticsSpy)).toMatchObject({
        sessionId: "session-secondary",
        descriptorChurnPercent: 0,
      }),
    );

    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={[
          {
            ...secondaryMessages[0],
            content: [{ type: "text", text: "Secondary changed" }],
          },
          ...secondaryMessages.slice(1),
        ]}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(
        latestTimelineDiagnostics(diagnosticsSpy)?.descriptorChurnPercent,
      ).toBeGreaterThan(0),
    );
  });

  it("defers mounted row finalization while layout is pending and finalizes after markers clear", async () => {
    mockTranscriptElementMeasurements();
    const diagnosticsSpy = vi.fn();
    const pendingMessage = textMessage(
      "pending",
      "assistant",
      "[pending] [height:12] Pending image",
    );
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[pendingMessage]}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(
        latestTimelineDiagnostics(diagnosticsSpy)?.measurement
          .reservedMeasurementsDeferred,
      ).toBeGreaterThan(0),
    );
    const acceptedBefore =
      latestTimelineDiagnostics(diagnosticsSpy)?.measurement
        .acceptedVisibleMeasurements ?? 0;

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          textMessage("pending", "assistant", "[height:360] Image ready"),
        ]}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    await waitFor(() =>
      expect(
        latestTimelineDiagnostics(diagnosticsSpy)?.measurement
          .acceptedVisibleMeasurements,
      ).toBeGreaterThan(acceptedBefore),
    );
    expect(
      latestTimelineDiagnostics(diagnosticsSpy)?.measurement
        .pendingMeasurements,
    ).toBe(0);
  });

  it("keeps latest assistant actions on the latest visible assistant", async () => {
    const visibleAssistant = textMessage(
      "visible-assistant",
      "assistant",
      "Visible assistant response",
    );
    const hiddenAssistant = textMessage(
      "hidden-assistant",
      "assistant",
      "Hidden assistant response",
      { userVisible: false },
    );

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[visibleAssistant, hiddenAssistant]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("bubble-visible-assistant")).toHaveAttribute(
        "data-actions-always-visible",
        "true",
      ),
    );
    expect(
      screen.queryByTestId("bubble-hidden-assistant"),
    ).not.toBeInTheDocument();
  });

  it("falls back to explicit safe degraded mode when protected rows exceed the fail threshold", async () => {
    const diagnosticsSpy = vi.fn();
    const messages = Array.from({ length: 82 }, (_, index) =>
      textMessage(`protected-${index}`, "assistant", `Protected ${index}`, {
        userVisible: true,
        completionStatus: "inProgress",
      }),
    );

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        onDiagnostics={diagnosticsSpy}
      />,
    );

    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute("data-virtual-render-mode", "safe-degraded"),
    );
    expect(list).toHaveAttribute("data-virtual-unmounting", "safe-degraded");
    expect(list).toHaveAttribute("data-virtual-total-rows", "83");
    expect(list).toHaveAttribute("data-virtual-mounted-rows", "83");
    expect(list).toHaveAttribute(
      "data-virtual-fallback-reasons",
      "protected-row-fail-threshold",
    );

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "safe-degraded",
          mountedRows: 83,
          protectedRows: 82,
          virtualUnmountingEnabled: false,
          fallbackReasons: ["protected-row-fail-threshold"],
        }),
      ),
    );
  });
});
