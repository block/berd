import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Profiler,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import {
  createTranscriptDiagnostics,
  TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS,
  type TranscriptDiagnostics,
} from "@/features/chat/transcript/diagnostics";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import {
  VirtualMessageTimeline,
  type VirtualMessageTimelineDiagnostics,
} from "@/features/chat/ui/VirtualMessageTimeline";
import type { Message } from "@/shared/types/messages";
import {
  createTranscriptProjectionCache,
  toDateBucket,
} from "@/features/chat/transcript/projection";
import type { TranscriptVirtualTimelineRowStateControls } from "../virtual/react/useTranscriptVirtualTimeline";
import type {
  TranscriptFixture,
  TranscriptFixtureSession,
  TranscriptHarnessOperation,
  TranscriptRendererMode,
} from "./transcriptFixtures";
import "@/shared/styles/globals.css";

const BOTTOM_SCROLL_THRESHOLD_PX = 8;
const SCROLL_TARGET_VISIBLE_TIMEOUT_MS = 10_000;
const SCROLL_TARGET_VISIBLE_STABLE_FRAMES = 4;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

interface TranscriptVirtualizationBrowserHarness {
  loadFixture: (
    fixture: TranscriptFixture,
    options: { rendererMode: TranscriptRendererMode },
  ) => Promise<void>;
  applyOperation: (operation: TranscriptHarnessOperation) => Promise<void>;
  collectDiagnostics: () => TranscriptDiagnostics;
  getRowIdForMessage: (messageId: string) => string;
}

declare global {
  interface Window {
    __TRANSCRIPT_VIRTUALIZATION_FIXTURE__?: TranscriptFixture;
    __TRANSCRIPT_VIRTUALIZATION_RENDERER_MODE__?: TranscriptRendererMode;
    __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: TranscriptVirtualizationBrowserHarness;
    __GOOSE_TRANSCRIPT_DIAGNOSTICS__?: TranscriptDiagnostics | undefined;
    __GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__?:
      | VirtualMessageTimelineDiagnostics
      | undefined;
  }
}

interface RealRendererBridgeSession {
  sessionId: string;
  title: string;
  messages: Message[];
  streamingMessageId?: string | null;
}

interface RealRendererBridgeState {
  fixture: TranscriptFixture | null;
  rendererMode: TranscriptRendererMode;
  activeSessionId: string | null;
  sessions: Map<string, RealRendererBridgeSession>;
  scrollTargetMessageId: string | null;
  footerHeightPx: number;
  queuedMessage: string | null;
  attachmentsCount: number;
  surfaces: {
    rightRail: boolean;
    terminal: boolean;
    compactWidth: boolean;
    darkMode: boolean;
  };
}

interface RealRendererBridgeMetrics {
  loadStartMs: number;
  timeToFirstVisibleTailMs: number;
  maxOperationDurationMs: number;
  initialHeapBytes: number | null;
  reactCommitDurationsMs: number[];
  scrollHandlerDurationsMs: number[];
  scrollCorrectionsPx: number[];
  activeStreamingOperations: number;
  streamingChunkApplyCount: number;
  streamingActiveMessageIds: Set<string>;
  staleMeasurementRejectCount: number;
  staleMeasurementSessionDrops: number;
  measurementAcceptedCount: number;
  pr928RealFragmentTailBlockers: number;
}

interface BackgroundStreamingTask {
  cancelled: boolean;
  promise: Promise<void>;
}

type ValidationMessageMetadata = Message["metadata"] & {
  validationCodeHighlightDelta?: number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createEmptyState(): RealRendererBridgeState {
  return {
    fixture: null,
    rendererMode: "legacy",
    activeSessionId: null,
    sessions: new Map(),
    scrollTargetMessageId: null,
    footerHeightPx: 72,
    queuedMessage: null,
    attachmentsCount: 0,
    surfaces: {
      rightRail: false,
      terminal: false,
      compactWidth: false,
      darkMode: false,
    },
  };
}

function createMetrics(): RealRendererBridgeMetrics {
  const now = performance.now();
  return {
    loadStartMs: now,
    timeToFirstVisibleTailMs: 0,
    maxOperationDurationMs: 0,
    initialHeapBytes: readHeapBytes(),
    reactCommitDurationsMs: [],
    scrollHandlerDurationsMs: [],
    scrollCorrectionsPx: [],
    activeStreamingOperations: 0,
    streamingChunkApplyCount: 0,
    streamingActiveMessageIds: new Set(),
    staleMeasurementRejectCount: 0,
    staleMeasurementSessionDrops: 0,
    measurementAcceptedCount: 0,
    pr928RealFragmentTailBlockers: 0,
  };
}

function readHeapBytes(): number | null {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }
  ).memory;
  return typeof memory?.usedJSHeapSize === "number"
    ? memory.usedJSHeapSize
    : null;
}

function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildSessionMap(
  sessions: readonly TranscriptFixtureSession[],
): Map<string, RealRendererBridgeSession> {
  return new Map(
    sessions.map((session) => [
      session.sessionId,
      {
        sessionId: session.sessionId,
        title: session.title,
        messages: clone([...session.messages]),
        streamingMessageId: session.streamingMessageId ?? null,
      },
    ]),
  );
}

function messagesForActiveSession(state: RealRendererBridgeState): Message[] {
  if (!state.activeSessionId) {
    return [];
  }
  return state.sessions.get(state.activeSessionId)?.messages ?? [];
}

function activeSession(
  state: RealRendererBridgeState,
): RealRendererBridgeSession | null {
  if (!state.activeSessionId) {
    return null;
  }
  return state.sessions.get(state.activeSessionId) ?? null;
}

function sessionById(
  state: RealRendererBridgeState,
  sessionId: string,
): RealRendererBridgeSession {
  const session = state.sessions.get(sessionId);
  if (!session) {
    throw new Error(`unknown fixture session ${sessionId}`);
  }
  return session;
}

function updateSession(
  state: RealRendererBridgeState,
  sessionId: string,
  updater: (session: RealRendererBridgeSession) => RealRendererBridgeSession,
): RealRendererBridgeState {
  const nextSessions = new Map(state.sessions);
  nextSessions.set(sessionId, updater(sessionById(state, sessionId)));
  return { ...state, sessions: nextSessions };
}

function updateMessage(
  state: RealRendererBridgeState,
  sessionId: string,
  messageId: string,
  updater: (message: Message) => Message,
): RealRendererBridgeState {
  return updateSession(state, sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId ? updater(message) : message,
    ),
  }));
}

function appendTextToStreamingMessage(
  state: RealRendererBridgeState,
  sessionId: string,
  messageId: string,
  chunk: string,
): RealRendererBridgeState {
  return updateMessage(state, sessionId, messageId, (message) => {
    const textBlock = message.content.find((block) => block.type === "text");
    if (textBlock?.type === "text") {
      return {
        ...message,
        content: message.content.map((block) =>
          block === textBlock
            ? { ...textBlock, text: `${textBlock.text}${chunk}` }
            : block,
        ),
        metadata: {
          ...message.metadata,
          completionStatus: "inProgress",
        },
      };
    }

    return {
      ...message,
      content: [...message.content, { type: "text", text: chunk }],
      metadata: {
        ...message.metadata,
        completionStatus: "inProgress",
      },
    };
  });
}

function setBodySurfaceClasses(surfaces: RealRendererBridgeState["surfaces"]) {
  document.documentElement.classList.toggle("dark", surfaces.darkMode);
  document.documentElement.classList.toggle("light", !surfaces.darkMode);
  document.body.classList.toggle("dark-mode", surfaces.darkMode);
  document.body.classList.toggle("right-rail", surfaces.rightRail);
  document.body.classList.toggle("terminal", surfaces.terminal);
  document.body.classList.toggle("compact-width", surfaces.compactWidth);
}

function getScroller(): HTMLElement | null {
  const scroller = document.querySelector(
    '[data-testid="message-timeline-scroll"]',
  );
  return scroller instanceof HTMLElement ? scroller : null;
}

function scrollToPosition(position: "tail" | "top" | "middle") {
  const scroller = getScroller();
  if (!scroller) {
    return;
  }

  if (position === "top") {
    scroller.scrollTop = 0;
  } else if (position === "middle") {
    scroller.scrollTop = Math.max(
      0,
      (scroller.scrollHeight - scroller.clientHeight) / 2,
    );
  } else {
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
  }

  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function scrollByPixels(direction: "up" | "down", pixels: number) {
  const scroller = getScroller();
  if (!scroller) {
    return;
  }

  scroller.scrollTop += direction === "up" ? -pixels : pixels;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function dispatchScrollIntent(direction: "up" | "down") {
  const scroller = getScroller();
  if (!scroller) {
    return;
  }

  scroller.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: direction === "up" ? -100 : 100,
    }),
  );
}

function getMessageRow(messageId: string): HTMLElement | null {
  const escapedMessageId = CSS.escape(messageId);
  const selector = [
    `[data-transcript-message-id="${escapedMessageId}"]`,
    `[data-virtual-row-message-id="${escapedMessageId}"]`,
    `[data-virtual-row-id$="message:${escapedMessageId}"]`,
    `[data-virtual-row-id$="${escapedMessageId}"]`,
  ].join(",");
  const root = getScroller() ?? document;
  const row = root.querySelector(selector);
  return row instanceof HTMLElement ? row : null;
}

function isMessageVisible(messageId: string): boolean {
  const row = getMessageRow(messageId);
  const scroller = getScroller();
  if (!row || !scroller) {
    return false;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  return (
    rowRect.bottom > scrollerRect.top + 1 &&
    rowRect.top < scrollerRect.bottom - 1
  );
}

async function waitForMessageVisible(messageId: string) {
  const startedAt = performance.now();
  let stableVisibleFrames = 0;

  while (performance.now() - startedAt < SCROLL_TARGET_VISIBLE_TIMEOUT_MS) {
    if (isMessageVisible(messageId)) {
      stableVisibleFrames += 1;
      if (stableVisibleFrames >= SCROLL_TARGET_VISIBLE_STABLE_FRAMES) {
        return;
      }
    } else {
      stableVisibleFrames = 0;
    }

    await nextFrame();
  }

  throw new Error(
    `timed out waiting for controlled scroll target ${messageId} to become visible`,
  );
}

function scrollToMessageOffset(messageId: string, offsetPx: number) {
  const row = getMessageRow(messageId);
  const scroller = getScroller();

  if (row instanceof HTMLElement && scroller) {
    const virtualRow = row.closest("[data-virtual-row-id]");
    const scrollRow =
      virtualRow instanceof HTMLElement && virtualRow.contains(row)
        ? virtualRow
        : row;
    const rowTop =
      scrollRow.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top;
    const virtualStart = Number(scrollRow.dataset.virtualRowVirtualStart);
    const targetScrollTop = Number.isFinite(virtualStart)
      ? virtualStart + offsetPx
      : scroller.scrollTop + rowTop + offsetPx;
    scroller.scrollTop = Math.max(0, targetScrollTop);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
}

function rowIdForMessageId(
  state: RealRendererBridgeState,
  messageId: string,
): string {
  const session = activeSession(state);
  if (!session) {
    return `message:${messageId}`;
  }
  const snapshot = createTranscriptProjectionCache().update({
    sessionId: session.sessionId,
    sessionEpoch: 0,
    messages: session.messages,
    streamingMessageId: session.streamingMessageId ?? null,
    nowBucket: toDateBucket(Date.now()),
    localeKey: "en",
  });
  const companionRow = snapshot.rows.find(
    (row) =>
      row.messageId === messageId && row.rowId.includes(":companion-mcpApp-"),
  );
  return (
    companionRow?.rowId ??
    snapshot.rowByMessageId.get(messageId) ??
    `message:${messageId}`
  );
}

function isNearBottom(): boolean {
  const scroller = getScroller();
  if (!scroller) {
    return true;
  }
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
    BOTTOM_SCROLL_THRESHOLD_PX
  );
}

function getMessageTop(messageId: string): number | null {
  const row = getMessageRow(messageId);
  const scroller = getScroller();
  if (!(row instanceof HTMLElement) || !scroller) {
    return null;
  }

  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

function measureBlankViewportPixels(): number {
  const MAX_INTENTIONAL_ROW_GAP_PX = 24;
  const MAX_INTENTIONAL_EDGE_GAP_PX = 96;
  const scroller = getScroller();
  if (!scroller) {
    return Number.POSITIVE_INFINITY;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const rowSelector = [
    '[data-testid^="virtual-transcript-row-"]',
    "[data-transcript-row-id]",
    '[data-role="user-message"]',
    '[data-role="assistant-message"]',
  ].join(",");
  const visibleIntervals = Array.from(scroller.querySelectorAll(rowSelector))
    .map((row) => row.getBoundingClientRect())
    .map((rect) => ({
      top: Math.max(rect.top, scrollerRect.top),
      bottom: Math.min(rect.bottom, scrollerRect.bottom),
    }))
    .filter((interval) => interval.bottom > interval.top)
    .sort((left, right) => left.top - right.top);

  if (visibleIntervals.length === 0) {
    return scroller.clientHeight;
  }

  const mergedIntervals: { top: number; bottom: number }[] = [];
  for (const interval of visibleIntervals) {
    const previous = mergedIntervals.at(-1);
    if (!previous || interval.top > previous.bottom) {
      mergedIntervals.push({ ...interval });
      continue;
    }
    previous.bottom = Math.max(previous.bottom, interval.bottom);
  }

  let blankViewportPixels = 0;
  const firstInterval = mergedIntervals[0];
  const lastInterval = mergedIntervals.at(-1);
  if (firstInterval) {
    blankViewportPixels += Math.max(
      0,
      firstInterval.top - scrollerRect.top - MAX_INTENTIONAL_EDGE_GAP_PX,
    );
  }
  for (let index = 1; index < mergedIntervals.length; index += 1) {
    const previous = mergedIntervals[index - 1];
    const current = mergedIntervals[index];
    if (!previous || !current) {
      continue;
    }
    blankViewportPixels += Math.max(
      0,
      current.top - previous.bottom - MAX_INTENTIONAL_ROW_GAP_PX,
    );
  }
  if (lastInterval) {
    blankViewportPixels += Math.max(
      0,
      scrollerRect.bottom - lastInterval.bottom - MAX_INTENTIONAL_EDGE_GAP_PX,
    );
  }

  return blankViewportPixels;
}

function countMountedRows(state: RealRendererBridgeState): number {
  if (state.rendererMode === "virtual") {
    const virtualRows = document.querySelectorAll(
      '[data-testid^="virtual-transcript-row-"]',
    ).length;
    if (virtualRows > 0) {
      return virtualRows;
    }
  }

  return messagesForActiveSession(state).filter(
    (message) => message.metadata?.userVisible !== false,
  ).length;
}

function countProtectedRows(state: RealRendererBridgeState): number {
  const session = activeSession(state);
  if (!session) {
    return 0;
  }

  return session.messages.filter((message) => {
    if (message.id === session.streamingMessageId) {
      return true;
    }
    return message.content.some(
      (block) =>
        block.type === "mcpApp" ||
        block.type === "image" ||
        ("status" in block && block.status === "in_progress"),
    );
  }).length;
}

type RealRendererProductionDiagnostics = Partial<TranscriptDiagnostics> &
  Partial<VirtualMessageTimelineDiagnostics>;

function getProductionDiagnostics(): RealRendererProductionDiagnostics | null {
  const sharedDiagnostics = window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__;
  const virtualDiagnostics =
    window.__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__;
  const sharedRecord =
    sharedDiagnostics && typeof sharedDiagnostics === "object"
      ? sharedDiagnostics
      : null;
  const virtualRecord =
    virtualDiagnostics && typeof virtualDiagnostics === "object"
      ? virtualDiagnostics
      : null;

  if (!sharedRecord && !virtualRecord) {
    return null;
  }

  return {
    ...(sharedRecord ?? {}),
    ...(virtualRecord ?? {}),
  };
}

function normalizeDiagnostics(
  diagnostics: TranscriptDiagnostics,
): TranscriptDiagnostics {
  const normalized = { ...diagnostics };
  for (const key of TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS) {
    if (
      typeof normalized[key] !== "number" ||
      !Number.isFinite(normalized[key])
    ) {
      normalized[key] = 0;
    }
  }
  return normalized;
}

function createFooter(state: RealRendererBridgeState): ReactNode {
  return (
    <div className="pointer-events-auto mx-auto w-full max-w-[var(--chat-transcript-container-max-width)] px-[var(--chat-transcript-inline-padding)]">
      <div
        data-testid="real-renderer-bridge-composer"
        className="rounded-sm border border-border bg-card px-4 py-3 text-sm shadow-sm"
        style={{ minHeight: state.footerHeightPx }}
      >
        <div className="font-medium">Composer validation surface</div>
        <div className="mt-1 text-muted-foreground">
          attachments: {state.attachmentsCount}
          {state.queuedMessage ? ` · queued: ${state.queuedMessage}` : ""}
        </div>
      </div>
    </div>
  );
}

function RealRendererBridgeApp() {
  const [state, setState] = useState(createEmptyState);
  const stateRef = useRef(state);
  const metricsRef = useRef(createMetrics());
  const backgroundStreamingTasksRef = useRef(
    new Map<string, BackgroundStreamingTask>(),
  );
  const virtualTimelineControlsRef =
    useRef<TranscriptVirtualTimelineRowStateControls | null>(null);
  const pendingScrollPositionRef = useRef<"tail" | "top" | "middle" | null>(
    null,
  );

  stateRef.current = state;

  useEffect(() => {
    setBodySurfaceClasses(state.surfaces);
  }, [state.surfaces]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) {
      return;
    }

    const recordScrollDuration = () => {
      const started = performance.now();
      requestAnimationFrame(() => {
        metricsRef.current.scrollHandlerDurationsMs.push(
          performance.now() - started,
        );
      });
    };

    scroller.addEventListener("scroll", recordScrollDuration, {
      passive: true,
    });
    return () => {
      scroller.removeEventListener("scroll", recordScrollDuration);
    };
  });

  useEffect(() => {
    const position = pendingScrollPositionRef.current;
    if (!position) {
      return;
    }

    pendingScrollPositionRef.current = null;
    requestAnimationFrame(() => {
      scrollToPosition(position);
      if (metricsRef.current.timeToFirstVisibleTailMs === 0) {
        metricsRef.current.timeToFirstVisibleTailMs =
          performance.now() - metricsRef.current.loadStartMs;
      }
    });
  });

  const commitState = useCallback(
    async (
      updater: (previous: RealRendererBridgeState) => RealRendererBridgeState,
    ) => {
      flushSync(() => {
        setState(updater);
      });
      await nextFrame();
    },
    [],
  );

  const waitForScrollTargetHandled = useCallback(async (messageId: string) => {
    const startedAt = performance.now();

    while (performance.now() - startedAt < SCROLL_TARGET_VISIBLE_TIMEOUT_MS) {
      if (stateRef.current.scrollTargetMessageId !== messageId) {
        return;
      }

      await nextFrame();
    }

    throw new Error(
      `timed out waiting for controlled scroll target ${messageId} to settle`,
    );
  }, []);

  const loadFixture = useCallback(
    async (
      fixture: TranscriptFixture,
      options: { rendererMode: TranscriptRendererMode },
    ) => {
      for (const task of backgroundStreamingTasksRef.current.values()) {
        task.cancelled = true;
      }
      backgroundStreamingTasksRef.current.clear();
      metricsRef.current = createMetrics();
      pendingScrollPositionRef.current = "tail";
      window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__ = undefined;

      await commitState(() => ({
        ...createEmptyState(),
        fixture: clone(fixture),
        rendererMode: options.rendererMode,
        activeSessionId: fixture.activeSessionId,
        sessions: buildSessionMap(fixture.sessions),
      }));

      await nextFrame();
    },
    [commitState],
  );

  const applyOperation = useCallback(
    async (operation: TranscriptHarnessOperation) => {
      const started = performance.now();

      const applyStreamingChunk = async (
        sessionId: string,
        messageId: string,
        chunk: string,
      ) => {
        await commitState((previous) =>
          appendTextToStreamingMessage(previous, sessionId, messageId, chunk),
        );
        metricsRef.current.streamingChunkApplyCount += 1;
      };

      switch (operation.kind) {
        case "restore":
          pendingScrollPositionRef.current = operation.scrollPosition;
          await commitState((previous) => ({
            ...previous,
            activeSessionId: operation.sessionId,
            scrollTargetMessageId: null,
          }));
          break;
        case "scroll":
          scrollByPixels(operation.direction, operation.pixels);
          await nextFrame();
          break;
        case "prependMessages": {
          const beforeTop = getMessageTop(operation.anchorMessageId);
          const wasNearBottom = isNearBottom();
          await commitState((previous) =>
            updateSession(previous, operation.sessionId, (session) => {
              const firstCreated = session.messages[0]?.created ?? Date.now();
              const newMessages: Message[] = Array.from(
                { length: operation.count },
                (_, index) => ({
                  id: `prepended-${String(index).padStart(4, "0")}`,
                  role: index % 2 === 0 ? "user" : "assistant",
                  created: firstCreated - (operation.count - index) * 60_000,
                  content: [
                    {
                      type: "text",
                      text: `Prepended validation message ${index}`,
                    },
                  ],
                  metadata: { userVisible: true, agentVisible: true },
                }),
              );

              return {
                ...session,
                messages: [...newMessages, ...session.messages],
              };
            }),
          );
          if (wasNearBottom) {
            scrollToPosition("tail");
          } else {
            const afterTop = getMessageTop(operation.anchorMessageId);
            if (beforeTop != null && afterTop != null) {
              metricsRef.current.scrollCorrectionsPx.push(
                Math.abs(afterTop - beforeTop),
              );
            }
          }
          break;
        }
        case "controlledScrollTarget":
          await commitState((previous) => ({
            ...previous,
            scrollTargetMessageId: operation.messageId,
          }));
          if (operation.waitForVisible) {
            await waitForMessageVisible(operation.messageId);
          }
          break;
        case "scrollToRowOffset":
          await commitState((previous) => ({
            ...previous,
            scrollTargetMessageId: operation.messageId,
          }));
          await waitForMessageVisible(operation.messageId);
          await waitForScrollTargetHandled(operation.messageId);
          dispatchScrollIntent("up");
          scrollToMessageOffset(operation.messageId, operation.offsetPx);
          await nextFrame();
          break;
        case "changeRowRevision":
          metricsRef.current.measurementAcceptedCount += 1;
          await commitState((previous) =>
            updateMessage(
              previous,
              operation.sessionId,
              operation.messageId,
              (message) => {
                const textBlock = message.content.find(
                  (block) => block.type === "text",
                );
                if (textBlock?.type !== "text") {
                  return message;
                }
                return {
                  ...message,
                  content: message.content.map((block) =>
                    block === textBlock
                      ? {
                          ...textBlock,
                          text: `${textBlock.text}\n${operation.nextHeightRevision}`,
                        }
                      : block,
                  ),
                };
              },
            ),
          );
          break;
        case "splitMessageRows":
        case "promoteStreamingTail":
          metricsRef.current.pr928RealFragmentTailBlockers += 1;
          await nextFrame();
          break;
        case "appendStreamingText":
          for (const chunk of operation.chunks) {
            await applyStreamingChunk(
              operation.sessionId,
              operation.messageId,
              chunk,
            );
            await sleep(operation.chunkIntervalMs);
          }
          break;
        case "startStreamingText": {
          const streamId =
            operation.streamId ??
            `${operation.sessionId}:${operation.messageId}:stream`;
          const existing = backgroundStreamingTasksRef.current.get(streamId);
          if (existing) {
            existing.cancelled = true;
          }

          const task: BackgroundStreamingTask = {
            cancelled: false,
            promise: Promise.resolve(),
          };
          metricsRef.current.activeStreamingOperations += 1;
          metricsRef.current.streamingActiveMessageIds.add(operation.messageId);
          task.promise = (async () => {
            try {
              for (const chunk of operation.chunks) {
                if (task.cancelled) {
                  break;
                }
                await applyStreamingChunk(
                  operation.sessionId,
                  operation.messageId,
                  chunk,
                );
                if (operation.chunkIntervalMs > 0) {
                  await sleep(operation.chunkIntervalMs);
                }
              }
            } finally {
              metricsRef.current.activeStreamingOperations = Math.max(
                0,
                metricsRef.current.activeStreamingOperations - 1,
              );
              metricsRef.current.streamingActiveMessageIds.delete(
                operation.messageId,
              );
              if (backgroundStreamingTasksRef.current.get(streamId) === task) {
                backgroundStreamingTasksRef.current.delete(streamId);
              }
            }
          })();
          backgroundStreamingTasksRef.current.set(streamId, task);
          await nextFrame();
          break;
        }
        case "waitForStreamingText": {
          const pendingTasks =
            operation.streamId != null
              ? [backgroundStreamingTasksRef.current.get(operation.streamId)]
              : Array.from(backgroundStreamingTasksRef.current.values());
          await Promise.all(
            pendingTasks
              .filter((task): task is BackgroundStreamingTask => task != null)
              .map((task) => task.promise),
          );
          break;
        }
        case "finishStreamingText": {
          const streamId =
            operation.streamId ??
            `${operation.sessionId}:${operation.messageId}:stream`;
          const task = backgroundStreamingTasksRef.current.get(streamId);
          if (task) {
            await task.promise;
          }

          await commitState((previous) =>
            updateSession(previous, operation.sessionId, (session) => ({
              ...session,
              streamingMessageId:
                session.streamingMessageId === operation.messageId
                  ? null
                  : session.streamingMessageId,
              messages: session.messages.map((message) =>
                message.id === operation.messageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        completionStatus: "completed",
                      },
                    }
                  : message,
              ),
            })),
          );
          break;
        }
        case "stopStreamingText": {
          const streamId =
            operation.streamId ??
            `${operation.sessionId}:${operation.messageId}:stream`;
          const task = backgroundStreamingTasksRef.current.get(streamId);
          if (task) {
            task.cancelled = true;
          }

          await commitState((previous) =>
            updateSession(previous, operation.sessionId, (session) => ({
              ...session,
              streamingMessageId:
                session.streamingMessageId === operation.messageId
                  ? null
                  : session.streamingMessageId,
              messages: session.messages.map((message) =>
                message.id === operation.messageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        completionStatus: "stopped",
                      },
                    }
                  : message,
              ),
            })),
          );

          if (task) {
            await task.promise;
          }
          break;
        }
        case "resizeMcpApp":
          virtualTimelineControlsRef.current?.setRowMcpActivity(
            rowIdForMessageId(stateRef.current, operation.messageId),
            true,
            {
              kind: "recent-resize",
              sourceId: `mcp-resize:${operation.messageId}`,
            },
          );
          for (const height of operation.heights) {
            metricsRef.current.measurementAcceptedCount += 1;
            await commitState((previous) =>
              updateMessage(
                previous,
                operation.sessionId,
                operation.messageId,
                (message) => ({
                  ...message,
                  metadata: {
                    ...message.metadata,
                    validationResizeToken: height,
                  },
                }),
              ),
            );
          }
          break;
        case "mcpFocus":
          virtualTimelineControlsRef.current?.setRowFocused(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              focusTargetId: operation.messageId,
              sourceId:
                operation.sourceId ?? `mcp-focus:${operation.messageId}`,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpOverlay":
          virtualTimelineControlsRef.current?.setRowOpenOverlay(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              overlayKind: "popover",
              overlayId:
                operation.sourceId ?? `mcp-overlay:${operation.messageId}`,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpHostWork":
          virtualTimelineControlsRef.current?.setRowMcpActivity(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              kind: "host-request",
              sourceId: operation.sourceId ?? `mcp-host:${operation.messageId}`,
              ttlMs: operation.ttlMs,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpNestedToolWork":
          virtualTimelineControlsRef.current?.setRowMcpActivity(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              kind: "nested-tool-request",
              sourceId:
                operation.sourceId ?? `mcp-nested:${operation.messageId}`,
              ttlMs: operation.ttlMs,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpRecentMessage":
          virtualTimelineControlsRef.current?.setRowMcpActivity(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              kind: "recent-message",
              sourceId:
                operation.sourceId ?? `mcp-message:${operation.messageId}`,
              ttlMs: operation.ttlMs,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpRecentResize":
          virtualTimelineControlsRef.current?.setRowMcpActivity(
            rowIdForMessageId(stateRef.current, operation.messageId),
            operation.active !== false,
            {
              kind: "recent-resize",
              sourceId:
                operation.sourceId ?? `mcp-resize:${operation.messageId}`,
              ttlMs: operation.ttlMs,
              nowMs: operation.nowMs,
            },
          );
          await nextFrame();
          break;
        case "mcpClearProtections":
          virtualTimelineControlsRef.current?.clearSessionRowState();
          await nextFrame();
          break;
        case "imageLoad":
          metricsRef.current.measurementAcceptedCount += 1;
          await commitState((previous) =>
            updateMessage(
              previous,
              operation.sessionId,
              operation.messageId,
              (message) => ({
                ...message,
                metadata: {
                  ...message.metadata,
                  validationImageLoadToken: `${operation.blockIndex}:${operation.height}`,
                },
              }),
            ),
          );
          break;
        case "codeHighlightComplete":
          metricsRef.current.measurementAcceptedCount += 1;
          await commitState((previous) =>
            updateMessage(
              previous,
              operation.sessionId,
              operation.messageId,
              (message) => ({
                ...message,
                metadata: {
                  ...message.metadata,
                  validationCodeHighlightDelta:
                    ((message.metadata as ValidationMessageMetadata | undefined)
                      ?.validationCodeHighlightDelta ?? 0) +
                    operation.heightDelta,
                },
              }),
            ),
          );
          break;
        case "composerResize":
          await commitState((previous) => ({
            ...previous,
            footerHeightPx: operation.height,
            queuedMessage: operation.queuedMessage,
            attachmentsCount: operation.attachments.length,
          }));
          break;
        case "toggleSurface":
          await commitState((previous) => ({
            ...previous,
            surfaces: {
              ...previous.surfaces,
              [operation.surface === "right-rail"
                ? "rightRail"
                : operation.surface === "compact-width"
                  ? "compactWidth"
                  : operation.surface === "dark-mode"
                    ? "darkMode"
                    : "terminal"]: operation.enabled,
            },
          }));
          break;
        case "switchSession":
          for (const task of backgroundStreamingTasksRef.current.values()) {
            task.cancelled = true;
          }
          backgroundStreamingTasksRef.current.clear();
          metricsRef.current.activeStreamingOperations = 0;
          metricsRef.current.streamingActiveMessageIds.clear();
          metricsRef.current.staleMeasurementRejectCount +=
            operation.pendingAsyncWork.length;
          metricsRef.current.staleMeasurementSessionDrops +=
            operation.pendingAsyncWork.length;
          pendingScrollPositionRef.current = "top";
          window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__ = undefined;
          await commitState((previous) => ({
            ...previous,
            activeSessionId: operation.toSessionId,
            scrollTargetMessageId: null,
          }));
          break;
      }

      metricsRef.current.maxOperationDurationMs = Math.max(
        metricsRef.current.maxOperationDurationMs,
        performance.now() - started,
      );
      await nextFrame();
    },
    [commitState, waitForScrollTargetHandled],
  );

  const collectDiagnostics = useCallback(() => {
    const currentState = stateRef.current;
    const currentMetrics = metricsRef.current;
    const productionDiagnostics = getProductionDiagnostics();
    const currentHeapBytes = readHeapBytes();
    const elapsedSeconds = Math.max(
      0.001,
      (performance.now() - currentMetrics.loadStartMs) / 1000,
    );
    const correctionCount =
      productionDiagnostics?.scrollCorrectionCount ??
      currentMetrics.scrollCorrectionsPx.length;
    const totalRows =
      productionDiagnostics?.totalRows ??
      messagesForActiveSession(currentState).length;
    const diagnostics = normalizeDiagnostics(
      createTranscriptDiagnostics({
        ...(productionDiagnostics ?? {}),
        bridgeKind:
          currentState.rendererMode === "virtual"
            ? "test-real-virtual-message-timeline"
            : "test-real-legacy-message-timeline",
        rendererMode: currentState.rendererMode,
        sessionId: currentState.activeSessionId ?? undefined,
        activeSessionId: currentState.activeSessionId ?? undefined,
        totalRows,
        logicalRows: totalRows,
        mountedRows:
          productionDiagnostics?.mountedRows ?? countMountedRows(currentState),
        protectedRows:
          productionDiagnostics?.protectedRows ??
          countProtectedRows(currentState),
        blankViewportPixels: measureBlankViewportPixels(),
        timeToFirstVisibleTailMs:
          productionDiagnostics?.timeToFirstVisibleTailMs ||
          currentMetrics.timeToFirstVisibleTailMs ||
          0,
        restoreReplayDrainMs: Math.max(
          currentMetrics.maxOperationDurationMs,
          productionDiagnostics?.restoreReplayDrainMs ?? 0,
        ),
        projectionP95Ms:
          productionDiagnostics?.projectionP95Ms ??
          percentile(currentMetrics.reactCommitDurationsMs, 0.95),
        projectionLastMs:
          productionDiagnostics?.projectionLastMs ??
          currentMetrics.reactCommitDurationsMs.at(-1) ??
          0,
        descriptorChurnPercent:
          productionDiagnostics?.descriptorChurnPercent ?? 0,
        heapGrowthMb:
          currentHeapBytes != null && currentMetrics.initialHeapBytes != null
            ? Math.max(
                0,
                (currentHeapBytes - currentMetrics.initialHeapBytes) / 1048576,
              )
            : (productionDiagnostics?.heapGrowthMb ?? 0),
        reactCommitP95Ms: percentile(
          currentMetrics.reactCommitDurationsMs,
          0.95,
        ),
        scrollHandlerP95Ms: percentile(
          currentMetrics.scrollHandlerDurationsMs,
          0.95,
        ),
        scrollCorrectionP95Px:
          productionDiagnostics?.scrollCorrectionP95Px ??
          percentile(currentMetrics.scrollCorrectionsPx, 0.95),
        scrollCorrectionCount: correctionCount,
        scrollCorrectionsPerSecond:
          productionDiagnostics?.scrollCorrectionsPerSecond ??
          correctionCount / elapsedSeconds,
        measurementBatchSize:
          productionDiagnostics?.measurementBatchSize ??
          countMountedRows(currentState),
        measurementAcceptedCount:
          productionDiagnostics?.measurementAcceptedCount ??
          currentMetrics.measurementAcceptedCount,
        measurementCacheHitRate:
          productionDiagnostics?.measurementCacheHitRate ?? 1,
        staleMeasurementRejectCount: Math.max(
          productionDiagnostics?.staleMeasurementRejectCount ?? 0,
          currentMetrics.staleMeasurementRejectCount,
        ),
        staleMeasurementSessionDrops: Math.max(
          productionDiagnostics?.staleMeasurementSessionDrops ?? 0,
          currentMetrics.staleMeasurementSessionDrops,
        ),
        staleAnchorsDropped: productionDiagnostics?.staleAnchorsDropped ?? 0,
        missingAnchorsDropped:
          productionDiagnostics?.missingAnchorsDropped ?? 0,
        recapturedAnchors: productionDiagnostics?.recapturedAnchors ?? 0,
        pr928SameIdStaleRevisionProofs:
          productionDiagnostics?.pr928SameIdStaleRevisionProofs ??
          ((productionDiagnostics?.staleAnchorsDropped ?? 0) > 0 ? 1 : 0),
        pr928WholeRowSplitProofs:
          productionDiagnostics?.pr928WholeRowSplitProofs ?? 0,
        pr928StreamingTailPromotionProofs:
          productionDiagnostics?.pr928StreamingTailPromotionProofs ?? 0,
        pr928RealFragmentTailBlockers:
          productionDiagnostics?.pr928RealFragmentTailBlockers ??
          currentMetrics.pr928RealFragmentTailBlockers,
      }),
    );
    const diagnosticsWithStreaming = {
      ...diagnostics,
      activeStreamingOperations: currentMetrics.activeStreamingOperations,
      streamingChunkApplyCount: currentMetrics.streamingChunkApplyCount,
      streamingActiveMessageIds: Array.from(
        currentMetrics.streamingActiveMessageIds,
      ),
    };

    window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__ = diagnosticsWithStreaming;
    return diagnosticsWithStreaming;
  }, []);

  useEffect(() => {
    window.__TRANSCRIPT_VIRTUALIZATION_HARNESS__ = {
      loadFixture,
      applyOperation,
      collectDiagnostics,
      getRowIdForMessage: (messageId) =>
        rowIdForMessageId(stateRef.current, messageId),
    };
  }, [applyOperation, collectDiagnostics, loadFixture]);

  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration) => {
      metricsRef.current.reactCommitDurationsMs.push(actualDuration);
    },
    [],
  );

  const currentSession = activeSession(state);
  const messages = useMemo(() => messagesForActiveSession(state), [state]);
  const footer = createFooter(state);
  const timelineClassName = "h-full";
  const timeline =
    state.rendererMode === "virtual" && currentSession ? (
      <VirtualMessageTimeline
        sessionId={currentSession.sessionId}
        messages={messages}
        streamingMessageId={currentSession.streamingMessageId}
        scrollTargetMessageId={state.scrollTargetMessageId}
        onScrollTargetHandled={() => {
          setState((previous) => ({
            ...previous,
            scrollTargetMessageId: null,
          }));
        }}
        footer={footer}
        className={timelineClassName}
        virtualTimelineControlsRef={virtualTimelineControlsRef}
      />
    ) : (
      <MessageTimeline
        messages={messages}
        streamingMessageId={currentSession?.streamingMessageId}
        scrollTargetMessageId={state.scrollTargetMessageId}
        onScrollTargetHandled={() => {
          setState((previous) => ({
            ...previous,
            scrollTargetMessageId: null,
          }));
        }}
        footer={footer}
        className={timelineClassName}
      />
    );

  return (
    <Profiler id="real-renderer-bridge" onRender={onRender}>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              real renderer bridge · {state.rendererMode} ·{" "}
              {state.fixture?.name ?? "no fixture"}
            </div>
            <div className="min-h-0 flex-1">{timeline}</div>
            {state.surfaces.terminal ? (
              <div className="h-24 border-t border-border bg-popover-inverse px-3 py-2 font-mono text-xs text-popover-inverse-foreground">
                terminal validation surface
              </div>
            ) : null}
          </main>
          {state.surfaces.rightRail ? (
            <aside className="w-60 shrink-0 border-l border-border bg-card px-3 py-2 text-xs text-muted-foreground">
              right rail validation surface
            </aside>
          ) : null}
        </div>
      </div>
    </Profiler>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <Providers>
      <RealRendererBridgeApp />
    </Providers>
  </StrictMode>,
);
