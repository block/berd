import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { ASSISTIVE_UX_STORAGE_KEY } from "@/shared/assistive-ux/registry";
import { RESPONSE_START_GUTTER_STORAGE_KEY } from "@/features/chat/lib/responseStartGutterPreference";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "@/features/experiments/experimentPreferences";
import type { Message } from "@/shared/types/messages";
import type { RunCommandOptions } from "@/shared/ui/ai-elements/runnable-code-block";
import {
  TRANSCRIPT_DIAGNOSTICS_EVENT,
  validateTranscriptDiagnostics,
  type TranscriptDiagnostics,
} from "../../transcript/diagnostics";
import type { TranscriptRowDescriptor } from "../../transcript/projection";
import {
  createLoadedTranscriptState,
  MEASUREMENT_FLUSH_FALLBACK_MS,
} from "../../transcript/virtual/react/useTranscriptVirtualTimeline";
import {
  TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTE,
  TRANSCRIPT_SELECTION_SURFACE_VALUE,
} from "../../transcript/virtual";
import {
  VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT,
  VirtualMessageTimeline,
  type VirtualMessageTimelineDiagnostics,
} from "../VirtualMessageTimeline";
import {
  getVirtualTranscriptRowSpacingBlockSize,
  getVirtualTranscriptRowSpacingClassName,
} from "../virtualTranscriptRowSpacing";

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
      sessionFeedbackSurvey,
      onEditProject,
      onRunShellCommand,
    }: {
      message: Message;
      isStreaming?: boolean;
      contentOverride?: readonly Message["content"][number][];
      fragmentRole?: string;
      actionsAlwaysVisible?: boolean;
      showJumpToResponseStartHint?: boolean;
      sessionFeedbackSurvey?: {
        appearanceId: string;
        messageId: string;
      };
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
          data-mock-row-height={
            sessionFeedbackSurvey ? "240" : (heightMatch?.[1] ?? "144")
          }
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
  localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  localStorage.removeItem(ASSISTIVE_UX_STORAGE_KEY);
  localStorage.removeItem(RESPONSE_START_GUTTER_STORAGE_KEY);
  resizeObserverCallbacks.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function mockTranscriptElementMeasurements(options?: {
  realRowsOffscreen?: () => boolean;
}) {
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
        const height = readNumericAttribute(
          measuredDescendant,
          "data-mock-row-height",
          144,
        );
        return options?.realRowsOffscreen?.()
          ? createPositionedDomRect(height, 2_000)
          : createDomRect(height);
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

function expectFlowPositionedVirtualRow(row: HTMLElement) {
  expect(row).toHaveClass("flow-root");
  expect(row.style.position).toBe("");
  expect(row.style.top).toBe("");
  expect(row.style.left).toBe("");
  expect(row.style.right).toBe("");
  expect(row.style.transform).toBe("");
}

function readPixelStyleValue(element: HTMLElement, property: "height"): number {
  const value = element.style[property];
  if (!value.endsWith("px")) {
    return Number.NaN;
  }

  return Number(value.slice(0, -2));
}

function createDomRect(height: number): DOMRect {
  return createPositionedDomRect(height, 0);
}

function createPositionedDomRect(height: number, top: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 800,
    top,
    width: 800,
    x: 0,
    y: top,
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

  // Timeline tests explicitly deliver animation frames. Swallow only the
  // measurement scheduler's timer fallback so wall-clock stalls cannot flush
  // rows at nondeterministic points; hook tests exercise the real fallback.
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const swallowedTimeoutIds = new Set<number>();
  let nextSwallowedTimeoutId = 0x40000000;
  vi.stubGlobal("setTimeout", (...args: Parameters<typeof realSetTimeout>) => {
    if (args[1] === MEASUREMENT_FLUSH_FALLBACK_MS) {
      nextSwallowedTimeoutId += 1;
      swallowedTimeoutIds.add(nextSwallowedTimeoutId);
      return nextSwallowedTimeoutId;
    }
    return realSetTimeout(...args);
  });
  vi.stubGlobal("clearTimeout", (timeoutId?: unknown) => {
    if (
      typeof timeoutId === "number" &&
      swallowedTimeoutIds.delete(timeoutId)
    ) {
      return;
    }
    realClearTimeout(timeoutId as Parameters<typeof realClearTimeout>[0]);
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

  it("keeps the floating response-start button hidden by default and shows it when enabled", async () => {
    mockTranscriptElementMeasurements();
    const assistant = textMessage(
      "assistant-1",
      "assistant",
      multiParagraphText("Assistant response", 3, 22),
    );

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={[assistant]} />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to current response start" }),
    ).not.toBeInTheDocument();

    localStorage.setItem(RESPONSE_START_GUTTER_STORAGE_KEY, "true");
    rerender(
      <VirtualMessageTimeline sessionId="session-1" messages={[assistant]} />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Jump to current response start",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("renders assistant fragment rows and projects mixed content into agent work", async () => {
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

    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        experiments: { "agent-work-transcript": { enabled: false } },
      }),
    );
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
    const agentWorkRow = screen.getByTestId(
      "virtual-transcript-row-message:mixed:agent-work",
    );

    expect(firstFragment).toHaveAttribute(
      "data-virtual-row-kind",
      "assistant-content-fragment",
    );
    expect(firstFragment).toHaveAttribute(
      "data-transcript-message-id",
      "fragmented",
    );
    expectFlowPositionedVirtualRow(firstFragment);
    expect(middleFragment).not.toHaveAttribute("data-transcript-message-id");
    expect(lastFragment).toHaveAttribute(
      "data-virtual-row-fragment-role",
      "end",
    );
    // Non-code-continuation fragments are spaced blocks, not zero-spaced continuations.
    expect(middleFragment).toHaveClass("pt-4");
    expect(lastFragment).toHaveClass("pt-4");
    expect(agentWorkRow).toHaveAttribute("data-virtual-row-kind", "agent-work");
    expect(agentWorkRow).toHaveAttribute("data-transcript-message-id", "mixed");

    expect(
      screen
        .getAllByTestId("bubble-fragmented")
        .map((element) => element.getAttribute("data-fragment-role")),
    ).toEqual(["start", "middle", "end"]);
    // This turn ends on a tool call with no final answer text below the
    // panel, so the trigger drops the "previous" qualifier.
    expect(screen.getByText(/^\d+ steps?$/)).toBeInTheDocument();

    const list = screen.getByTestId("virtual-message-timeline-list");
    expect(list).toHaveAttribute("data-virtual-fragment-rows", "3");
    expect(list).toHaveAttribute(
      "data-virtual-whole-message-fallback-rows",
      "0",
    );

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fragmentRowCount: 3,
          completedFragmentRowCount: 3,
          wholeMessageFallbackRowCount: 0,
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
    expect(
      getVirtualTranscriptRowSpacingClassName({
        row: normalRow,
        index: 3,
        previousRowKind: "message",
        layoutMode: "flow",
      }),
    ).toBe("pt-4");
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
    await waitFor(() =>
      expect(
        screen.getAllByTestId("virtual-message-timeline-flow-spacer").length,
      ).toBeGreaterThan(0),
    );
    expect(history.style.height).toBe("");
    expect(history.style.position).toBe("relative");
    expect(list).toHaveAttribute(
      TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTE,
      TRANSCRIPT_SELECTION_SURFACE_VALUE,
    );
    expect(history).toHaveAttribute(
      TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTE,
      TRANSCRIPT_SELECTION_SURFACE_VALUE,
    );
    expect(list).toHaveStyle({ paddingBottom: "0px" });
    expect(
      history.querySelector<HTMLElement>(
        '[data-virtual-row-kind="date-separator"]',
      ),
    ).toHaveClass("flow-root");

    const lastRenderedRowEnd = Math.max(
      ...Array.from(
        history.querySelectorAll<HTMLElement>("[data-virtual-row-virtual-end]"),
      ).map((row) =>
        Number(row.getAttribute("data-virtual-row-virtual-end") ?? 0),
      ),
    );
    const trailingSpacer = screen
      .getAllByTestId("virtual-message-timeline-flow-spacer")
      .at(-1) as HTMLElement;
    expect(
      lastRenderedRowEnd + readPixelStyleValue(trailingSpacer, "height"),
    ).toBe(198);
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
    expectFlowPositionedVirtualRow(fragmentedRow);
    expect(
      Number(fragmentedRow.getAttribute("data-virtual-row-virtual-start")),
    ).toBeGreaterThan(0);
    expect(
      screen
        .getAllByTestId("virtual-message-timeline-flow-spacer")
        .some((spacer) => readPixelStyleValue(spacer, "height") > 0),
    ).toBe(true);
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

  it("keeps the edge flow spacers mounted when the transcript rerenders", async () => {
    mockTranscriptElementMeasurements();
    const messages = Array.from({ length: 160 }, (_, index) =>
      textMessage(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Message ${index}`,
      ),
    );
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );

    const history = screen.getByTestId("virtual-message-timeline-history");
    let leadingSpacer: Element | null = null;
    let trailingSpacer: Element | null = null;
    await waitFor(() => {
      leadingSpacer = history.querySelector(
        '[data-virtual-flow-spacer="before"]',
      );
      trailingSpacer = history.querySelector(
        '[data-virtual-flow-spacer="after"]',
      );
      expect(leadingSpacer).not.toBeNull();
      expect(trailingSpacer).not.toBeNull();
    });

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages.slice(0, 120)}
      />,
    );

    await waitFor(() =>
      expect(history).toHaveAttribute("data-virtual-history-rows"),
    );
    expect(history.querySelector('[data-virtual-flow-spacer="before"]')).toBe(
      leadingSpacer,
    );
    expect(history.querySelector('[data-virtual-flow-spacer="after"]')).toBe(
      trailingSpacer,
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

  it("updates live agent work text before the turn completes", () => {
    const user = textMessage("user-1", "user", "Please inspect");
    const assistant: Message = {
      id: "assistant-work",
      role: "assistant",
      created: Date.UTC(2026, 5, 4, 12, 1, 0),
      metadata: { userVisible: true },
      content: [
        { type: "thinking", text: "Planning" },
        { type: "text", text: "Streaming answer part one" },
      ],
    };

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[user, assistant]}
        streamingMessageId="assistant-work"
      />,
    );

    expect(screen.getByText("Streaming answer part one")).toBeInTheDocument();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          user,
          {
            ...assistant,
            content: [
              { type: "thinking", text: "Planning" },
              {
                type: "text",
                text: "Streaming answer part one and now part two",
              },
            ],
          },
        ]}
        streamingMessageId="assistant-work"
      />,
    );

    expect(
      screen.getByText("Streaming answer part one and now part two"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("message-assistant-work:answer")).toBeNull();
  });

  it("keeps a revealed agent-work row anchored as its measured height grows", () => {
    mockTranscriptElementMeasurements();
    const animationFrame = mockRequestAnimationFrame();
    const assistant: Message = {
      id: "assistant-work",
      role: "assistant",
      created: Date.UTC(2026, 5, 4, 12, 1, 0),
      metadata: { userVisible: true },
      content: [
        { type: "thinking", text: "Planning" },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "scan",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "Final answer" },
      ],
    };
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={[assistant]} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    const scrollTo = attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    animationFrame.runAll(0);
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /previous steps?/ }));
    animationFrame.runAll(100);
    scrollTo.mockClear();

    const agentWorkRow = screen.getByTestId(
      "virtual-transcript-row-message:assistant-work:agent-work",
    );
    agentWorkRow.setAttribute("data-mock-row-height", "480");
    triggerResizeObservers();
    animationFrame.runAll(200);

    expect(scroller.scrollTop).toBe(500);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("mounts a just-settled agent-work row open before collapsing", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const user = textMessage("user-1", "user", "Please inspect");
    const streamingAssistant: Message = {
      id: "assistant-work",
      role: "assistant",
      created: Date.UTC(2026, 5, 4, 12, 1, 0),
      metadata: { userVisible: true },
      content: [
        { type: "thinking", text: "Planning" },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "scan",
          arguments: {},
          status: "in_progress",
        },
        { type: "text", text: "Streaming answer" },
      ],
    };
    const settledAssistant: Message = {
      ...streamingAssistant,
      content: [
        { type: "thinking", text: "Planning" },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "scan",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "Final answer" },
      ],
    };

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[user, streamingAssistant]}
        streamingMessageId="assistant-work"
      />,
    );

    expect(
      screen.getByTestId("virtual-message-timeline-live-tail"),
    ).toBeInTheDocument();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[user, settledAssistant]}
        streamingMessageId={null}
      />,
    );

    const agentWorkRow = screen.getByTestId(
      "virtual-transcript-row-message:assistant-work:agent-work",
    );
    expect(agentWorkRow).toHaveTextContent(/previous steps?/);
    const collapsibleContent = agentWorkRow.querySelector(
      '[data-slot="collapsible-content"]',
    );
    expect(collapsibleContent).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Final answer")).toBeInTheDocument();

    animationFrame.runAll(100);

    expect(collapsibleContent).toHaveAttribute("data-state", "closed");
  });

  it("handles scroll targets for agent-work-led assistant turns", async () => {
    mockTranscriptElementMeasurements();
    const onScrollTargetHandled = vi.fn();

    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[activeToolMessage("assistant-work")]}
        scrollTargetMessageId="assistant-work"
        onScrollTargetHandled={onScrollTargetHandled}
      />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 300,
    });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        ...createDomRect(300),
        bottom: 300,
        top: 0,
      }),
    });

    const agentWorkRow = await screen.findByTestId(
      "virtual-transcript-row-message:assistant-work:agent-work",
    );
    expect(agentWorkRow).toHaveAttribute("data-virtual-row-kind", "agent-work");
    await waitFor(() =>
      expect(onScrollTargetHandled).toHaveBeenCalledWith("assistant-work"),
    );
  });

  it("falls back to the mounted live tail element for active streaming scroll targets", async () => {
    mockTranscriptElementMeasurements();
    const onScrollTargetHandled = vi.fn();

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
        onScrollTargetHandled={onScrollTargetHandled}
      />,
    );

    const streamingRow = await screen.findByTestId(
      "virtual-transcript-row-message:assistant-1",
    );
    expect(
      screen.getByTestId("virtual-message-timeline-live-tail"),
    ).toContainElement(streamingRow);
    expect(onScrollTargetHandled).not.toHaveBeenCalled();
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

    // Scroll back up toward the start of the response so its action chevron is
    // pushed out of the active reading band; the hint must withdraw even though
    // it has already been earned for this message.
    fireEvent.wheel(scroller, { deltaY: -120 });
    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 1400,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("bubble-assistant-1")
          .some(
            (element) =>
              element.getAttribute("data-response-start-hint") === "true",
          ),
      ).toBe(false),
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

  it("resumes following a live flow tail when touch scrolling reaches latest", async () => {
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
    attachScrollTo(scroller);

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

    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.touchMove(scroller);
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

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
  });

  it("treats Space as scrolling toward latest during streaming reattach", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage(
        "assistant-1",
        "assistant",
        `${longText("streaming fragment", 120)}\n[height:650]`,
      ),
    ];
    renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId="assistant-1"
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);

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

    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.keyDown(scroller, { key: " " });
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("preserves detached near-bottom position when a live flow tail completes", async () => {
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
    attachScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    fireEvent.wheel(scroller, { deltaY: -80 });
    setScrollMetrics(scroller, {
      scrollTop: 4650,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId={null}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(4650));
  });

  it("bounds live-tail handoff ownership to one frame", async () => {
    const animationFrame = mockRequestAnimationFrame();
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
    animationFrame.runAll(0);
    setScrollMetrics(scroller, {
      scrollTop: 4700,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    fireEvent.wheel(scroller, { deltaY: -80 });
    setScrollMetrics(scroller, {
      scrollTop: 4650,
      scrollHeight: 5000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId={null}
      />,
    );
    expect(animationFrame.run(1001)).toBe(true);
  });

  it("releases the live-tail scroll-height floor after restoring a detached reader", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      ...Array.from({ length: 160 }, (_, index) =>
        textMessage(
          `message-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `Message ${index}`,
        ),
      ),
      textMessage(
        "streaming-tail",
        "assistant",
        `${longText("streaming fragment", 120)}\n[height:650]`,
      ),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId="streaming-tail"
      />,
    );
    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-render-mode",
        "bounded-controller",
      ),
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    const capturedDomScrollHeight = 80000;
    setScrollMetrics(scroller, {
      scrollTop: 100,
      scrollHeight: capturedDomScrollHeight,
      clientHeight: 300,
    });
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId={null}
      />,
    );

    await waitFor(() => {
      const trailingSpacer = screen
        .getAllByTestId("virtual-message-timeline-flow-spacer")
        .at(-1) as HTMLElement;
      expect(readPixelStyleValue(trailingSpacer, "height")).toBeLessThan(
        capturedDomScrollHeight / 2,
      );
      expect(scroller.scrollTop).toBeLessThan(capturedDomScrollHeight / 2);
    });
    const restoredDetachedScrollTop = scroller.scrollTop;

    // Render the completed state once more. The restore cleared its handoff,
    // so this explicitly exercises the no-handoff cleanup path and proves the
    // released floor cannot return on a later render.
    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        streamingMessageId={null}
      />,
    );
    const trailingSpacer = screen
      .getAllByTestId("virtual-message-timeline-flow-spacer")
      .at(-1) as HTMLElement;
    expect(readPixelStyleValue(trailingSpacer, "height")).toBeLessThan(
      capturedDomScrollHeight / 2,
    );
    expect(scroller.scrollTop).toBe(restoredDetachedScrollTop);
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

  it("follows a new voice user turn like a composer submission", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage(
        "assistant-1",
        "assistant",
        `${longText("history", 80)}\n[height:900]`,
      ),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    fireEvent.wheel(scroller, { deltaY: -300 });
    setScrollMetrics(scroller, {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    const voiceMessage = textMessage(
      "voice-local",
      "user",
      "Spoken follow-up",
      {
        userVisible: true,
        origin: "voice_conversation",
        voiceConversationLifecycleId: "lifecycle-1",
        voiceUtteranceId: "utterance-1",
        voiceConversationRevision: 0,
      },
    );
    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[...messages, voiceMessage]}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(200));
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    fireEvent.wheel(scroller, { deltaY: -300 });
    setScrollMetrics(scroller, {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[...messages, { ...voiceMessage, id: "voice-backend" }]}
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(200));
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("follows a new voice turn appended with an assistant continuation", async () => {
    mockTranscriptElementMeasurements();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage(
        "assistant-1",
        "assistant",
        `${longText("history", 80)}\n[height:900]`,
      ),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    fireEvent.wheel(scroller, { deltaY: -300 });
    setScrollMetrics(scroller, {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          ...messages,
          textMessage("voice-local", "user", "Spoken follow-up", {
            userVisible: true,
            origin: "voice_conversation",
            voiceConversationLifecycleId: "lifecycle-1",
            voiceUtteranceId: "utterance-1",
            voiceConversationRevision: 0,
          }),
          textMessage("assistant-2", "assistant", "Working"),
        ]}
        streamingMessageId="assistant-2"
      />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(200));
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("keeps following latest after an intent-less upward scroll correction", async () => {
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    attachScrollTo(scroller);
    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    expect(scroller.scrollTop).toBe(500);
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

  it("keeps a scrollbar drag stable when resize reconciliation beats the scroll event", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    // A native scrollbar drag updates scrollTop before React receives the
    // corresponding scroll event. Resize/measurement reconciliation in that
    // gap must treat the browser viewport as authoritative.
    fireEvent.pointerDown(scroller);
    scroller.scrollTop = 300;
    triggerResizeObservers();
    animationFrame.runAll(1000);

    expect(scroller.scrollTop).toBe(300);
  });

  it("keeps wheel scrolling stable when transcript measurement beats the scroll event", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    // Wheel intent arrives before the browser's corresponding scroll event.
    // A transcript update in that gap must not replay the previous anchor.
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 640;
    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          messages[0],
          textMessage("assistant-1", "assistant", "Updated answer"),
        ]}
      />,
    );
    animationFrame.runAll(1000);

    expect(scroller.scrollTop).toBe(640);
  });

  it("expires wheel ownership when no scroll event follows", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);

    // Boundary and horizontal wheel gestures may not produce a scroll event.
    // Their browser ownership must expire before a later reconciliation.
    fireEvent.wheel(scroller, { deltaY: 0 });
    expect(animationFrame.run(1000)).toBe(true);
    scroller.scrollTop = 640;
    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          messages[0],
          textMessage("assistant-1", "assistant", "Updated answer"),
        ]}
      />,
    );
    animationFrame.runAll(2000);

    expect(scroller.scrollTop).toBe(700);
  });

  it("pauses streaming bottom follow while the user owns the scrollbar", () => {
    const animationFrame = mockRequestAnimationFrame();
    const initialMessages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Streaming answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={initialMessages}
        streamingMessageId="assistant-1"
      />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(scroller, {
      scrollTop: 700,
      scrollHeight: 1100,
      clientHeight: 300,
    });
    fireEvent.scroll(scroller);
    fireEvent.pointerDown(scroller);
    scroller.scrollTop = 300;

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          initialMessages[0],
          textMessage("assistant-1", "assistant", "Streaming answer update"),
        ]}
        streamingMessageId="assistant-1"
      />,
    );
    animationFrame.runAll(1000);

    expect(scroller.scrollTop).toBe(300);
  });

  it("replaces the complete virtual renderer when the loaded transcript object changes", () => {
    const primaryTranscript = createLoadedTranscriptState("session-primary");
    const replacementTranscript =
      createLoadedTranscriptState("session-primary");
    const messages = [textMessage("primary-user", "user", "Question")];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        loadedTranscript={primaryTranscript}
        sessionId="session-primary"
        messages={messages}
      />,
    );
    const primaryScroller = screen.getByTestId("message-timeline-scroll");

    rerender(
      <VirtualMessageTimeline
        loadedTranscript={replacementTranscript}
        sessionId="session-primary"
        messages={messages}
      />,
    );

    const replacementScroller = screen.getByTestId("message-timeline-scroll");
    expect(replacementScroller).not.toBe(primaryScroller);
    expect(primaryScroller.isConnected).toBe(false);
    expect(replacementScroller.isConnected).toBe(true);
  });

  it("replaces the complete virtual renderer instance when switching sessions", () => {
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-primary"
        messages={[textMessage("primary-user", "user", "Question")]}
      />,
    );
    const primaryScroller = screen.getByTestId("message-timeline-scroll");

    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={[textMessage("secondary-user", "user", "Another question")]}
      />,
    );

    const secondaryScroller = screen.getByTestId("message-timeline-scroll");
    expect(secondaryScroller).not.toBe(primaryScroller);
    expect(primaryScroller.isConnected).toBe(false);
    expect(secondaryScroller.isConnected).toBe(true);
  });

  it("releases scrollbar-drag ownership when switching sessions", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const primaryMessages = [
      textMessage("primary-user", "user", "Question"),
      textMessage("primary-assistant", "assistant", "Answer"),
    ];
    const secondaryMessages = [
      textMessage("secondary-user", "user", "Another question"),
      textMessage("secondary-assistant", "assistant", "Another answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-primary"
        messages={primaryMessages}
      />,
    );
    const primaryScroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(primaryScroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.pointerDown(primaryScroller);

    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={secondaryMessages}
      />,
    );
    const secondaryScroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(secondaryScroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    triggerResizeObservers();
    animationFrame.runAll(1000);

    expect(primaryScroller.isConnected).toBe(false);
    expect(secondaryScroller.scrollTop).toBe(700);
  });

  it("releases wheel ownership when switching sessions", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const primaryMessages = [
      textMessage("primary-user", "user", "Question"),
      textMessage("primary-assistant", "assistant", "Answer"),
    ];
    const secondaryMessages = [
      textMessage("secondary-user", "user", "Another question"),
      textMessage("secondary-assistant", "assistant", "Another answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline
        sessionId="session-primary"
        messages={primaryMessages}
      />,
    );
    const primaryScroller = screen.getByTestId("message-timeline-scroll");
    animationFrame.runAll(0);
    setScrollMetrics(primaryScroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    fireEvent.wheel(primaryScroller, { deltaY: 0 });

    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={secondaryMessages}
      />,
    );
    const secondaryScroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(secondaryScroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    rerender(
      <VirtualMessageTimeline
        sessionId="session-secondary"
        messages={[
          secondaryMessages[0],
          textMessage("secondary-assistant", "assistant", "Updated answer"),
        ]}
      />,
    );
    triggerResizeObservers();
    animationFrame.runAll(1000);

    expect(primaryScroller.isConnected).toBe(false);
    expect(secondaryScroller.scrollTop).toBe(700);
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
        diagnosticEvents.at(-1)?.measurement.offscreenShellMeasurementAttempts,
      ).toBeGreaterThan(0),
    );
    expect(
      diagnosticEvents.at(-1)?.measurement.acceptedOffscreenShellMeasurements,
    ).toBe(0);
    await waitFor(() =>
      expect(
        diagnosticEvents.at(-1)?.measurement.acceptedOffscreenRealMeasurements,
      ).toBeGreaterThan(0),
    );
    const offscreenRealHost = screen.getByTestId(
      "virtual-offscreen-real-measurement-host",
    );
    expect(offscreenRealHost).toHaveAttribute("aria-hidden", "true");
    expect(offscreenRealHost.style.userSelect).toBe("none");
    expect(offscreenRealHost.style.height).toBe("0px");
    expect(offscreenRealHost.style.overflow).toBe("clip");
    expect(offscreenRealHost.style.transform).toBe("");
    const offscreenRealRow = offscreenRealHost.querySelector<HTMLElement>(
      "[data-virtual-row-offscreen-real-id]",
    );
    expect(offscreenRealRow).not.toBeNull();
    expect(offscreenRealRow as HTMLElement).toHaveAttribute(
      "data-virtual-row-selectable",
      "false",
    );
    expect((offscreenRealRow as HTMLElement).style.userSelect).toBe("none");
    const offscreenShellHost = screen.getByTestId(
      "virtual-offscreen-measurement-host",
    );
    expect(offscreenShellHost).toHaveAttribute("aria-hidden", "true");
    expect(offscreenShellHost.style.height).toBe("0px");
    expect(offscreenShellHost.style.overflow).toBe("clip");
    expect(offscreenShellHost.style.transform).toBe("");
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

  it("real-measures an offscreen row before mounting its localized survey", async () => {
    mockTranscriptElementMeasurements();
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Message ${index}`,
      ),
    );
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const list = screen.getByTestId("virtual-message-timeline-list");
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-render-mode",
        "bounded-controller",
      ),
    );

    const shellRows = screen
      .getByTestId("virtual-offscreen-measurement-host")
      .querySelectorAll<HTMLElement>(
        "[data-virtual-row-offscreen-shell-id^='message:message-']",
      );
    const targetShellRow = [...shellRows].reverse().find((row) => {
      const messageId = row
        .getAttribute("data-virtual-row-offscreen-shell-id")
        ?.replace("message:", "");
      const index = Number(messageId?.replace("message-", ""));
      return index % 2 === 1;
    });
    expect(targetShellRow).toBeDefined();
    const targetMessageId = targetShellRow
      ?.getAttribute("data-virtual-row-offscreen-shell-id")
      ?.replace("message:", "");
    const initialHeightRevision = targetShellRow?.getAttribute(
      "data-virtual-row-height-revision",
    );
    expect(targetMessageId).toBeTruthy();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        sessionFeedbackSurvey={{
          appearanceId: "appearance-localized",
          messageId: targetMessageId as string,
        }}
      />,
    );

    const realRow = await waitFor(() => {
      const row = screen
        .getByTestId("virtual-offscreen-real-measurement-host")
        .querySelector<HTMLElement>(
          `[data-virtual-row-offscreen-real-id='message:${targetMessageId}']`,
        );
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    expect(realRow).toHaveAttribute(
      "data-virtual-row-measurement-policy",
      "measure-real",
    );
    expect(realRow.getAttribute("data-virtual-row-height-revision")).not.toBe(
      initialHeightRevision,
    );
    expect(realRow.getAttribute("data-virtual-row-height-revision")).toContain(
      "session-survey:appearance-localized:en",
    );
    expect(realRow.querySelector("[data-mock-row-height]"))?.toHaveAttribute(
      "data-mock-row-height",
      "240",
    );
  });

  it("inspects a blank viewport after ordinary scroll ownership expires without a range change", async () => {
    let now = 0;
    let realRowsOffscreen = false;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animationFrame = mockRequestAnimationFrame();
    mockTranscriptElementMeasurements({
      realRowsOffscreen: () => realRowsOffscreen,
    });
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    const list = screen.getByTestId("virtual-message-timeline-list");
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 500 });
    animationFrame.runAll(now);
    expect(list).toHaveAttribute(
      "data-virtual-blank-viewport-recovery-attempts",
      "0",
    );
    const realRowCoverageReadSpy = vi.spyOn(
      screen.getByRole("log"),
      "querySelectorAll",
    );

    realRowsOffscreen = true;
    now = 10;
    fireEvent.scroll(scroller);
    animationFrame.runAll(now);
    expect(realRowCoverageReadSpy).not.toHaveBeenCalledWith(
      "[data-virtual-row-id]",
    );
    expect(list).toHaveAttribute(
      "data-virtual-blank-viewport-recovery-attempts",
      "0",
    );

    now = 111;
    animationFrame.runAll(now);
    expect(realRowCoverageReadSpy).toHaveBeenCalledWith(
      "[data-virtual-row-id]",
    );
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-blank-viewport-recovery-attempts",
        "2",
      ),
    );
  });

  it("inspects and recovers a blank viewport after resize with an unchanged range", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const animationFrame = mockRequestAnimationFrame();
    let realRowsOffscreen = false;
    mockTranscriptElementMeasurements({
      realRowsOffscreen: () => realRowsOffscreen,
    });
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    const list = screen.getByTestId("virtual-message-timeline-list");
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 500 });
    animationFrame.runAll(1_000);
    expect(list).toHaveAttribute(
      "data-virtual-blank-viewport-recovery-attempts",
      "0",
    );
    const renderedRowIdsBeforeResize = Array.from(
      list.querySelectorAll("[data-virtual-row-id]"),
      (row) => row.getAttribute("data-virtual-row-id"),
    );

    realRowsOffscreen = true;
    triggerResizeObservers();
    animationFrame.runAll(1_000);

    expect(
      Array.from(list.querySelectorAll("[data-virtual-row-id]"), (row) =>
        row.getAttribute("data-virtual-row-id"),
      ),
    ).toEqual(renderedRowIdsBeforeResize);
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-blank-viewport-recovery-attempts",
        "2",
      ),
    );
  });

  it("resets blank viewport recovery attempts across distinct range revisions", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const animationFrame = mockRequestAnimationFrame();
    mockTranscriptElementMeasurements({ realRowsOffscreen: () => true });
    const messages = Array.from({ length: 80 }, (_, index) =>
      textMessage(`message-${index}`, "assistant", `Message ${index}`),
    );

    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );

    const list = screen.getByTestId("virtual-message-timeline-list");
    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 500 });
    animationFrame.runAll(1_000);
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-blank-viewport-recovery-attempts",
        "2",
      ),
    );

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={[
          ...messages,
          textMessage("message-80", "assistant", "Message 80"),
        ]}
      />,
    );

    expect(list).toHaveAttribute(
      "data-virtual-blank-viewport-recovery-attempts",
      "0",
    );
    animationFrame.runAll(1_000);
    await waitFor(() =>
      expect(list).toHaveAttribute(
        "data-virtual-blank-viewport-recovery-attempts",
        "2",
      ),
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
      "virtual-transcript-row-message:active-tool:agent-work",
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
    expect(activeToolRow).toHaveAttribute(
      "data-virtual-row-selectable",
      "false",
    );
    expect(activeToolRow.style.pointerEvents).toBe("none");
    expect(activeToolRow.style.userSelect).toBe("none");

    const visibleTailRow = await screen.findByTestId(
      "virtual-transcript-row-message:message-79",
    );
    await waitFor(() =>
      expect(visibleTailRow).toHaveAttribute(
        "data-virtual-row-visible",
        "true",
      ),
    );
    expect(visibleTailRow).toHaveAttribute(
      "data-virtual-row-selectable",
      "true",
    );
    expect(visibleTailRow.style.pointerEvents).toBe("");
    expect(visibleTailRow.style.userSelect).toBe("");

    const offscreenHost = await screen.findByTestId(
      "virtual-offscreen-measurement-host",
    );
    expect(
      offscreenHost.querySelector(
        '[data-virtual-row-offscreen-shell-id="message:active-tool:agent-work"]',
      ),
    ).toBeNull();
    expect(
      screen
        .queryByTestId("virtual-offscreen-real-measurement-host")
        ?.querySelector(
          '[data-virtual-row-offscreen-real-id="message:active-tool:agent-work"]',
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
        diagnosticsSpy.mock.calls.some(([diagnostics]) => {
          const sample = diagnostics as VirtualMessageTimelineDiagnostics;
          return (
            sample.sessionId === "session-secondary" &&
            sample.descriptorChurnPercent > 0
          );
        }),
      ).toBe(true),
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

  it("keeps virtualization bounded when active-stream rows exceed the fail threshold", async () => {
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
      expect(list).toHaveAttribute(
        "data-virtual-render-mode",
        "bounded-controller",
      ),
    );
    expect(list).toHaveAttribute("data-virtual-unmounting", "enabled");
    expect(list).toHaveAttribute("data-virtual-total-rows", "83");
    expect(list).toHaveAttribute("data-virtual-protected-rows", "40");
    expect(list).toHaveAttribute("data-virtual-fallback-reasons", "");

    await waitFor(() =>
      expect(diagnosticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "bounded-controller",
          protectedRows: 40,
          virtualUnmountingEnabled: true,
          fallbackReasons: [],
        }),
      ),
    );
  });
});
