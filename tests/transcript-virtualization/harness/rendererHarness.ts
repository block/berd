import type { Page } from "@playwright/test";
import {
  createTranscriptDiagnosticsFromVirtualTimelineDiagnostics,
  type TranscriptVirtualTimelineDiagnosticsInput,
} from "../../../src/features/chat/transcript/diagnostics";
import type {
  TranscriptFixture,
  TranscriptHarnessOperation,
  TranscriptRendererMode,
} from "../../../src/features/chat/transcript/testing/transcriptFixtures";
import {
  collectTranscriptViewportEvidence,
  DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
  filterTranscriptBrowserMetricsForProductionTiming,
  readTranscriptBrowserMetricsClock,
  startTranscriptBrowserMetrics,
  stopTranscriptBrowserMetrics,
  type TranscriptBrowserMetricExclusionWindow,
  type TranscriptBrowserMetrics,
  type TranscriptViewportEvidence,
  type TranscriptViewportSelectors,
} from "./browserMetrics";
import { installLocalTranscriptRendererBridge } from "./localRendererBridge";
import {
  collectTranscriptOperationTimingMetrics,
  filterTranscriptOperationTimingMetricsForProductionTiming,
  installTranscriptOperationTimingInstrumentation,
  preferDiagnosticTranscriptOperationTimingMetrics,
  readTranscriptOperationTimingMetricsFromDiagnostics,
  resetTranscriptOperationTiming,
  type TranscriptOperationTimingMetrics,
} from "./operationTiming";

export interface TranscriptRendererHarnessOptions {
  rendererUrl: string;
  rendererMode: TranscriptRendererMode;
  fixture: TranscriptFixture;
  selectors?: TranscriptViewportSelectors;
}

export interface TranscriptRendererRunResult {
  metrics: TranscriptBrowserMetrics;
  productionTimingMetrics: TranscriptBrowserMetrics;
  bridgeTimingExclusionWindows: readonly TranscriptBrowserMetricExclusionWindow[];
  operationTimingMetrics: TranscriptOperationTimingMetrics;
  productionOperationTimingMetrics: TranscriptOperationTimingMetrics;
  viewport: TranscriptViewportEvidence;
  diagnostics: Record<string, unknown>;
  productionDiagnostics: Record<string, unknown> | null;
  operationEvidence: readonly TranscriptOperationEvidence[];
}

export interface TranscriptVisibleRowSnapshot {
  rowId: string;
  messageId: string | null;
  topPx: number;
  bottomPx: number;
  anchorPriority: string | null;
  heightRevision: string | null;
  renderRevision: string | null;
}

export interface TranscriptScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  nearBottom: boolean;
  visibleRows: readonly TranscriptVisibleRowSnapshot[];
  firstVisibleRow: TranscriptVisibleRowSnapshot | null;
  firstAnchorableVisibleRow: TranscriptVisibleRowSnapshot | null;
}

export interface TranscriptOperationEvidence {
  operationIndex: number;
  operation: TranscriptHarnessOperation;
  scheduledAtMs: number;
  beforeElapsedMs: number;
  applyStartedElapsedMs: number;
  applyEndedElapsedMs: number;
  afterElapsedMs: number;
  applyDurationMs: number;
  before: TranscriptScrollSnapshot;
  after: TranscriptScrollSnapshot;
}

export interface TranscriptStreamingTailRowSnapshot {
  rowId: string;
  messageId: string | null;
  heightRevision: string | null;
  renderRevision: string | null;
  visible: boolean | null;
  protected: boolean | null;
}

export interface TranscriptVirtualTimelineDomCounters {
  totalRows: number;
  mountedRows: number;
  completedStreamingFragmentRowCount: number;
  streamingTailRowCount: number;
  visibleStartIndex: number;
  visibleEndIndex: number;
  renderStartIndex: number;
  renderEndIndex: number;
  virtualUnmountingEnabled: boolean;
  fallbackReasons: readonly string[];
  streamingTailRows: readonly TranscriptStreamingTailRowSnapshot[];
}

export interface TranscriptStreamingScrollbackSample {
  elapsedMs: number;
  viewport: TranscriptViewportEvidence;
  scroll: TranscriptScrollSnapshot;
  diagnostics: Record<string, unknown>;
  dom: TranscriptVirtualTimelineDomCounters;
}

export interface TranscriptStreamingScrollbackEvidence {
  samples: readonly TranscriptStreamingScrollbackSample[];
}

interface TranscriptVirtualizationBrowserHarness {
  loadFixture?: (
    fixture: TranscriptFixture,
    options: { rendererMode: TranscriptRendererMode },
  ) => void | Promise<void>;
  applyOperation?: (
    operation: TranscriptHarnessOperation,
  ) => void | Promise<void>;
  collectDiagnostics?: () =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
}

interface TranscriptHarnessWindow extends Window {
  __TRANSCRIPT_VIRTUALIZATION_FIXTURE__?: TranscriptFixture;
  __TRANSCRIPT_VIRTUALIZATION_RENDERER_MODE__?: TranscriptRendererMode;
  __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: TranscriptVirtualizationBrowserHarness;
  __GOOSE_TRANSCRIPT_DIAGNOSTICS__?: Record<string, unknown>;
  __GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__?: TranscriptVirtualTimelineDiagnosticsInput;
}

const TRANSCRIPT_SCROLL_STABILITY_EPSILON_PX = 1;
const TRANSCRIPT_SCROLL_STABILITY_FRAMES = 2;
const TRANSCRIPT_SCROLL_STABILITY_MAX_FRAMES = 12;
const TRANSCRIPT_FILLED_VIEWPORT_STABILITY_FRAMES = 2;
const TRANSCRIPT_FILLED_VIEWPORT_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function appendRendererQuery(
  rendererUrl: string,
  fixture: TranscriptFixture,
  rendererMode: TranscriptRendererMode,
): string {
  const url = new URL(rendererUrl);
  url.searchParams.set("transcriptFixture", fixture.name);
  url.searchParams.set("transcriptRenderer", rendererMode);
  return url.toString();
}

export async function loadTranscriptRenderer(
  page: Page,
  options: TranscriptRendererHarnessOptions,
) {
  const { fixture, rendererMode, rendererUrl } = options;
  const selectors = options.selectors ?? DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS;

  await installTranscriptOperationTimingInstrumentation(page, {
    scrollerSelector: selectors.scroller,
  });
  await installLocalTranscriptRendererBridge(page, rendererUrl);
  await page.addInitScript(
    ({ serializedFixture, mode }) => {
      const harnessWindow = window as TranscriptHarnessWindow;
      harnessWindow.__TRANSCRIPT_VIRTUALIZATION_FIXTURE__ = serializedFixture;
      harnessWindow.__TRANSCRIPT_VIRTUALIZATION_RENDERER_MODE__ = mode;
      localStorage.setItem(
        "goose:transcriptVirtualizationFixture",
        JSON.stringify(serializedFixture),
      );
      localStorage.setItem("goose:transcriptVirtualizationRenderer", mode);
      // The harness runs through Vite's dev server but validates production
      // renderer defaults. Keep unrelated dev-auto-enabled experiments from
      // changing the transcript shape and invalidating performance thresholds.
      localStorage.setItem(
        "goose:experimental-features",
        JSON.stringify({ version: 2, autoEnable: false, experiments: {} }),
      );
    },
    { serializedFixture: fixture, mode: rendererMode },
  );

  await page.goto(appendRendererQuery(rendererUrl, fixture, rendererMode));
  await page.waitForFunction(
    () => {
      const harnessWindow = window as TranscriptHarnessWindow;
      return Boolean(harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__);
    },
    undefined,
    { timeout: 5_000 },
  );

  await page.evaluate(
    async ({ serializedFixture, mode }) => {
      const harnessWindow = window as TranscriptHarnessWindow;
      await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.loadFixture?.(
        serializedFixture,
        { rendererMode: mode },
      );
    },
    { serializedFixture: fixture, mode: rendererMode },
  );
  await settleTranscriptRendererAfterLoad(page, rendererMode);
}

async function settleTranscriptRendererAfterLoad(
  page: Page,
  rendererMode: TranscriptRendererMode,
) {
  await page.evaluate(
    async ({ mode }) => {
      const waitForFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (let frame = 0; frame < (mode === "virtual" ? 4 : 2); frame += 1) {
        await waitForFrame();
      }
    },
    { mode: rendererMode },
  );

  if (rendererMode !== "virtual") {
    return;
  }

  await page
    .waitForFunction(
      () => {
        const harnessWindow = window as TranscriptHarnessWindow;
        const diagnostics = harnessWindow.__GOOSE_TRANSCRIPT_DIAGNOSTICS__;
        return (
          typeof diagnostics?.timeToFirstVisibleTailMs === "number" &&
          diagnostics.timeToFirstVisibleTailMs > 0
        );
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
}

async function settleTranscriptRendererAfterOperation(page: Page) {
  await page.evaluate(async () => {
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    await waitForFrame();
    await waitForFrame();
  });
}

export async function playTranscriptOperations(
  page: Page,
  operations: readonly TranscriptHarnessOperation[],
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptOperationEvidence[]> {
  const operationEvidence: TranscriptOperationEvidence[] = [];

  for (const [operationIndex, operation] of operations.entries()) {
    const scheduledClock = await readTranscriptBrowserMetricsClock(page);
    await page.waitForTimeout(
      Math.max(0, operation.atMs - scheduledClock.elapsedMs),
    );
    const beforeClock = await readTranscriptBrowserMetricsClock(page);
    const before = await waitForStableTranscriptScrollSnapshot(page, selectors);

    const applyTiming = await page.evaluate(
      async ({ nextOperation, viewportSelectors }) => {
        const startedAtMs = performance.now();
        const harnessWindow = window as TranscriptHarnessWindow;
        const bridge = harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__;
        const scrollToPreferredMessageTarget = (
          messageId: string,
          offsetPx: number,
          onlyStreamingTail = false,
        ): boolean => {
          const scroller = document.querySelector(viewportSelectors.scroller);
          if (!(scroller instanceof HTMLElement)) {
            return false;
          }

          const escapedMessageId = CSS.escape(messageId);
          const root = scroller;
          const preferredRow = root.querySelector(
            `[data-transcript-message-id="${escapedMessageId}"]`,
          );
          const fallbackRow = root.querySelector(
            [
              `[data-virtual-row-message-id="${escapedMessageId}"]`,
              `[data-virtual-row-id$="message:${escapedMessageId}"]`,
              `[data-virtual-row-id$="${escapedMessageId}"]`,
            ].join(","),
          );
          const row =
            preferredRow instanceof HTMLElement
              ? preferredRow
              : fallbackRow instanceof HTMLElement
                ? fallbackRow
                : null;

          if (
            onlyStreamingTail &&
            (!(preferredRow instanceof HTMLElement) ||
              preferredRow.dataset.virtualRowStreamingTail !== "true")
          ) {
            return false;
          }

          if (!row) {
            return false;
          }

          const rowTop =
            row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top;
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollTop + rowTop + offsetPx,
          );
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          return true;
        };

        if (bridge?.applyOperation) {
          if (nextOperation.kind === "scroll") {
            const scroller = document.querySelector(viewportSelectors.scroller);
            scroller?.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaY:
                  nextOperation.direction === "up"
                    ? -nextOperation.pixels
                    : nextOperation.pixels,
              }),
            );
          }
          await bridge.applyOperation(nextOperation);
          if (nextOperation.kind === "scrollToRowOffset") {
            scrollToPreferredMessageTarget(
              nextOperation.messageId,
              nextOperation.offsetPx,
              true,
            );
          }
          return {
            endedAtMs: performance.now(),
            startedAtMs,
          };
        }

        const scroller = document.querySelector(viewportSelectors.scroller);
        if (!(scroller instanceof HTMLElement)) {
          window.dispatchEvent(
            new CustomEvent("transcript-fixture-operation", {
              detail: nextOperation,
            }),
          );
          return {
            endedAtMs: performance.now(),
            startedAtMs,
          };
        }

        switch (nextOperation.kind) {
          case "restore":
            if (nextOperation.scrollPosition === "tail") {
              scroller.scrollTop = scroller.scrollHeight;
            } else if (nextOperation.scrollPosition === "top") {
              scroller.scrollTop = 0;
            } else {
              scroller.scrollTop =
                (scroller.scrollHeight - scroller.clientHeight) / 2;
            }
            break;
          case "scroll":
            scroller.scrollBy({
              top:
                nextOperation.direction === "up"
                  ? -nextOperation.pixels
                  : nextOperation.pixels,
            });
            break;
          case "scrollToRowOffset": {
            scrollToPreferredMessageTarget(
              nextOperation.messageId,
              nextOperation.offsetPx,
            );
            break;
          }
          default:
            window.dispatchEvent(
              new CustomEvent("transcript-fixture-operation", {
                detail: nextOperation,
              }),
            );
        }
        return {
          endedAtMs: performance.now(),
          startedAtMs,
        };
      },
      { nextOperation: operation, viewportSelectors: selectors },
    );

    await settleTranscriptRendererAfterOperation(page);
    const after = await waitForStableTranscriptScrollSnapshot(page, selectors);
    const afterClock = await readTranscriptBrowserMetricsClock(page);
    operationEvidence.push({
      operationIndex,
      operation,
      scheduledAtMs: operation.atMs,
      beforeElapsedMs: beforeClock.elapsedMs,
      applyStartedElapsedMs: applyTiming.startedAtMs - beforeClock.startTime,
      applyEndedElapsedMs: applyTiming.endedAtMs - beforeClock.startTime,
      afterElapsedMs: afterClock.elapsedMs,
      applyDurationMs: applyTiming.endedAtMs - applyTiming.startedAtMs,
      before,
      after,
    });
  }

  return operationEvidence;
}

export async function collectTranscriptRendererDiagnostics(
  page: Page,
): Promise<Record<string, unknown>> {
  const bridgeDiagnostics = await page.evaluate(async () => {
    const harnessWindow = window as TranscriptHarnessWindow;
    const diagnostics =
      await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.();
    return diagnostics ?? null;
  });

  if (isRecord(bridgeDiagnostics)) {
    return bridgeDiagnostics;
  }

  return (await collectProductionTranscriptRendererDiagnostics(page)) ?? {};
}

export async function collectProductionTranscriptRendererDiagnostics(
  page: Page,
): Promise<Record<string, unknown> | null> {
  const productionDiagnostics = await page.evaluate(() => {
    const diagnosticsWindow = window as TranscriptHarnessWindow;
    return {
      shared: diagnosticsWindow.__GOOSE_TRANSCRIPT_DIAGNOSTICS__ ?? null,
      virtual:
        diagnosticsWindow.__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__ ??
        null,
    };
  });

  if (isRecord(productionDiagnostics.shared)) {
    return productionDiagnostics.shared;
  }

  if (isRecord(productionDiagnostics.virtual)) {
    return createTranscriptDiagnosticsFromVirtualTimelineDiagnostics(
      productionDiagnostics.virtual,
    );
  }

  return null;
}

export async function collectTranscriptScrollSnapshot(
  page: Page,
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptScrollSnapshot> {
  return page.evaluate(
    ({ viewportSelectors, bottomThresholdPx }) => {
      const scroller = document.querySelector(viewportSelectors.scroller);
      if (!(scroller instanceof HTMLElement)) {
        return {
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          distanceFromBottom: 0,
          nearBottom: true,
          visibleRows: [],
          firstVisibleRow: null,
          firstAnchorableVisibleRow: null,
        };
      }

      const rowContainerSelector = [
        '[data-testid^="virtual-transcript-row-"]',
        "[data-transcript-row-id]",
      ].join(",");
      const rowFallbackSelector = [
        '[data-role="user-message"]',
        '[data-role="assistant-message"]',
      ].join(",");
      const rowElements = Array.from(
        scroller.querySelectorAll(rowContainerSelector),
      );
      const candidateRows =
        rowElements.length > 0
          ? rowElements
          : Array.from(scroller.querySelectorAll(rowFallbackSelector));
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleRows = candidateRows
        .filter((row): row is HTMLElement => row instanceof HTMLElement)
        .map((row) => {
          const rect = row.getBoundingClientRect();
          const rowId =
            row.dataset.virtualRowId ??
            row.dataset.transcriptRowId ??
            row.getAttribute("data-testid") ??
            row.getAttribute("data-role") ??
            "";
          const messageId =
            row.dataset.virtualRowMessageId ??
            row.dataset.transcriptMessageId ??
            row.dataset.messageId ??
            null;
          return {
            row,
            rowId,
            messageId,
            topPx: rect.top - scrollerRect.top,
            bottomPx: rect.bottom - scrollerRect.top,
          };
        })
        .filter(
          (row) =>
            row.rowId.length > 0 &&
            row.bottomPx > 1 &&
            row.topPx < scroller.clientHeight - 1,
        )
        .sort((left, right) => left.topPx - right.topPx);

      const toSnapshot = (entry: (typeof visibleRows)[number] | undefined) => {
        if (!entry) {
          return null;
        }

        const { row, rowId, messageId, topPx, bottomPx } = entry;
        const messagePrefixIndex = rowId.lastIndexOf("message:");
        return {
          rowId,
          messageId:
            messageId ??
            (messagePrefixIndex >= 0
              ? rowId.slice(messagePrefixIndex + "message:".length)
              : null),
          topPx,
          bottomPx,
          anchorPriority: row.dataset.virtualRowAnchorPriority ?? null,
          heightRevision: row.dataset.virtualRowHeightRevision ?? null,
          renderRevision: row.dataset.virtualRowRenderRevision ?? null,
        };
      };

      const firstAnchorable =
        visibleRows.find(
          ({ row }) =>
            (row.dataset.virtualRowAnchorPriority ?? "stable") !== "none",
        ) ?? null;
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        distanceFromBottom,
        nearBottom: distanceFromBottom <= bottomThresholdPx,
        visibleRows: visibleRows.map(toSnapshot).filter((row) => row != null),
        firstVisibleRow: toSnapshot(visibleRows[0]),
        firstAnchorableVisibleRow: toSnapshot(firstAnchorable ?? undefined),
      };
    },
    { viewportSelectors: selectors, bottomThresholdPx: 8 },
  );
}

export async function waitForStableTranscriptScrollSnapshot(
  page: Page,
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptScrollSnapshot> {
  let previous = await collectTranscriptScrollSnapshot(page, selectors);
  let stableFrames = 0;

  for (
    let frame = 0;
    frame < TRANSCRIPT_SCROLL_STABILITY_MAX_FRAMES;
    frame += 1
  ) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const next = await collectTranscriptScrollSnapshot(page, selectors);
    if (areTranscriptScrollSnapshotsStable(previous, next)) {
      stableFrames += 1;
      if (stableFrames >= TRANSCRIPT_SCROLL_STABILITY_FRAMES) {
        return next;
      }
    } else {
      stableFrames = 0;
    }
    previous = next;
  }

  return previous;
}

function areTranscriptScrollSnapshotsStable(
  previous: TranscriptScrollSnapshot,
  next: TranscriptScrollSnapshot,
): boolean {
  return (
    Math.abs(next.scrollTop - previous.scrollTop) <=
      TRANSCRIPT_SCROLL_STABILITY_EPSILON_PX &&
    Math.abs(next.scrollHeight - previous.scrollHeight) <=
      TRANSCRIPT_SCROLL_STABILITY_EPSILON_PX &&
    Math.abs(next.clientHeight - previous.clientHeight) <=
      TRANSCRIPT_SCROLL_STABILITY_EPSILON_PX
  );
}

export async function waitForFilledTranscriptViewport(
  page: Page,
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptViewportEvidence> {
  let previous = await collectTranscriptViewportEvidence(page, selectors);
  let stableFrames = previous.blankViewportPixels <= 0 ? 1 : 0;
  const deadline = Date.now() + TRANSCRIPT_FILLED_VIEWPORT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const next = await collectTranscriptViewportEvidence(page, selectors);
    if (next.blankViewportPixels <= 0 && previous.blankViewportPixels <= 0) {
      stableFrames += 1;
      if (stableFrames >= TRANSCRIPT_FILLED_VIEWPORT_STABILITY_FRAMES) {
        return next;
      }
    } else {
      stableFrames = next.blankViewportPixels <= 0 ? 1 : 0;
    }
    previous = next;
  }

  return previous;
}

function hasFilledDiagnosticViewport(diagnostics: Record<string, unknown>) {
  return (
    typeof diagnostics.blankViewportPixels === "number" &&
    Number.isFinite(diagnostics.blankViewportPixels) &&
    diagnostics.blankViewportPixels <= 0
  );
}

async function waitForFilledTranscriptRendererDiagnostics(
  page: Page,
): Promise<Record<string, unknown>> {
  let previous = await collectTranscriptRendererDiagnostics(page);
  let stableFrames = hasFilledDiagnosticViewport(previous) ? 1 : 0;
  const deadline = Date.now() + TRANSCRIPT_FILLED_VIEWPORT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const next = await collectTranscriptRendererDiagnostics(page);
    const isFilled = hasFilledDiagnosticViewport(next);
    const wasFilled = hasFilledDiagnosticViewport(previous);
    if (isFilled && wasFilled) {
      stableFrames += 1;
      if (stableFrames >= TRANSCRIPT_FILLED_VIEWPORT_STABILITY_FRAMES) {
        return next;
      }
    } else {
      stableFrames = isFilled ? 1 : 0;
    }
    previous = next;
  }

  return previous;
}

export async function collectTranscriptVirtualTimelineDomCounters(
  page: Page,
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptVirtualTimelineDomCounters> {
  return page.evaluate((viewportSelectors) => {
    const parseNumber = (value: string | undefined): number => {
      if (value == null || value.length === 0) {
        return 0;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const parseBoolean = (value: string | undefined): boolean | null => {
      if (value === "true" || value === "enabled") {
        return true;
      }
      if (value === "false" || value === "safe-degraded") {
        return false;
      }
      return null;
    };
    const root = document.querySelector(
      '[data-testid="virtual-message-timeline-list"]',
    );
    const dataset = root instanceof HTMLElement ? root.dataset : undefined;
    const scroller = document.querySelector(viewportSelectors.scroller);
    const tailRows = scroller
      ? Array.from(
          scroller.querySelectorAll('[data-virtual-row-id*="stream-tail"]'),
        )
      : [];

    return {
      totalRows: parseNumber(dataset?.virtualTotalRows),
      mountedRows: parseNumber(dataset?.virtualMountedRows),
      completedStreamingFragmentRowCount: parseNumber(
        dataset?.virtualCompletedStreamingFragmentRows,
      ),
      streamingTailRowCount: parseNumber(dataset?.virtualStreamingTailRows),
      visibleStartIndex: parseNumber(dataset?.virtualVisibleStart),
      visibleEndIndex: parseNumber(dataset?.virtualVisibleEnd),
      renderStartIndex: parseNumber(dataset?.virtualRenderStart),
      renderEndIndex: parseNumber(dataset?.virtualRenderEnd),
      virtualUnmountingEnabled:
        parseBoolean(dataset?.virtualUnmounting) === true,
      fallbackReasons:
        dataset?.virtualFallbackReasons
          ?.split(",")
          .map((reason) => reason.trim())
          .filter((reason) => reason.length > 0) ?? [],
      streamingTailRows: tailRows
        .filter((row): row is HTMLElement => row instanceof HTMLElement)
        .map((row) => ({
          rowId: row.dataset.virtualRowId ?? "",
          messageId: row.dataset.virtualRowMessageId ?? null,
          heightRevision: row.dataset.virtualRowHeightRevision ?? null,
          renderRevision: row.dataset.virtualRowRenderRevision ?? null,
          visible: parseBoolean(row.dataset.virtualRowVisible),
          protected: parseBoolean(row.dataset.virtualRowProtected),
        }))
        .filter((row) => row.rowId.length > 0),
    };
  }, selectors);
}

export async function collectTranscriptStreamingScrollbackEvidence(
  page: Page,
  options: {
    durationMs: number;
    sampleIntervalMs: number;
    selectors?: TranscriptViewportSelectors;
  },
): Promise<TranscriptStreamingScrollbackEvidence> {
  const selectors = options.selectors ?? DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS;
  const startedAt = Date.now();
  const samples: TranscriptStreamingScrollbackSample[] = [];

  while (Date.now() - startedAt <= options.durationMs) {
    const [viewport, scroll, diagnostics, dom] = await Promise.all([
      collectTranscriptViewportEvidence(page, selectors),
      collectTranscriptScrollSnapshot(page, selectors),
      collectTranscriptRendererDiagnostics(page),
      collectTranscriptVirtualTimelineDomCounters(page, selectors),
    ]);
    samples.push({
      elapsedMs: Date.now() - startedAt,
      viewport,
      scroll,
      diagnostics,
      dom,
    });
    await page.waitForTimeout(options.sampleIntervalMs);
  }

  return { samples };
}

export async function runTranscriptRendererHarness(
  page: Page,
  options: TranscriptRendererHarnessOptions,
): Promise<TranscriptRendererRunResult> {
  const selectors = options.selectors ?? DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS;

  await loadTranscriptRenderer(page, options);
  await resetTranscriptOperationTiming(page);
  await startTranscriptBrowserMetrics(page);
  const operationEvidence = await playTranscriptOperations(
    page,
    options.fixture.operations,
    selectors,
  );
  const metrics = await stopTranscriptBrowserMetrics(page);
  const bridgeTimingExclusionWindows = operationEvidence.map((evidence) => ({
    startTime: metrics.startTime + evidence.applyStartedElapsedMs,
    endTime: metrics.startTime + evidence.afterElapsedMs,
    reason: `fixture-operation:${evidence.operation.kind}`,
  }));
  const productionTimingMetrics =
    filterTranscriptBrowserMetricsForProductionTiming(
      metrics,
      bridgeTimingExclusionWindows,
    );
  const harnessOperationTimingMetrics =
    await collectTranscriptOperationTimingMetrics(page);
  const viewport = await waitForFilledTranscriptViewport(page, selectors);
  const productionDiagnostics =
    await collectProductionTranscriptRendererDiagnostics(page);
  const diagnostics = await waitForFilledTranscriptRendererDiagnostics(page);
  const diagnosticOperationTimingMetrics =
    readTranscriptOperationTimingMetricsFromDiagnostics(
      productionDiagnostics,
      metrics.startTime,
      metrics.endTime,
    );
  const operationTimingMetrics =
    preferDiagnosticTranscriptOperationTimingMetrics(
      diagnosticOperationTimingMetrics,
      harnessOperationTimingMetrics,
    );
  const productionOperationTimingMetrics =
    filterTranscriptOperationTimingMetricsForProductionTiming(
      operationTimingMetrics,
      bridgeTimingExclusionWindows,
    );

  return {
    metrics,
    productionTimingMetrics,
    bridgeTimingExclusionWindows,
    operationTimingMetrics,
    productionOperationTimingMetrics,
    viewport,
    diagnostics,
    productionDiagnostics,
    operationEvidence,
  };
}
