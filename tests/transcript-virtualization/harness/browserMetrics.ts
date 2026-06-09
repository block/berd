import type { Page } from "@playwright/test";

export interface TranscriptLongTaskMetric {
  name: string;
  startTime: number;
  relativeStartTime: number;
  duration: number;
  attribution: readonly TranscriptLongTaskAttributionMetric[];
}

export interface TranscriptLongTaskAttributionMetric {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
  containerName?: string;
}

export interface TranscriptFrameIntervalMetric {
  startTime: number;
  endTime: number;
  duration: number;
}

export interface TranscriptBrowserMetricExclusionWindow {
  startTime: number;
  endTime: number;
  reason: string;
}

export interface TranscriptBrowserMetrics {
  startTime: number;
  endTime: number;
  durationMs: number;
  frameCount: number;
  droppedFrameCount: number;
  droppedFrameRate: number;
  frameIntervalP95Ms: number;
  frameIntervals: readonly TranscriptFrameIntervalMetric[];
  longTasks: readonly TranscriptLongTaskMetric[];
  longTasksOver50Ms: number;
  ignoredLongTasksBeforeStart: number;
}

export interface TranscriptViewportEvidence {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  mountedRowCount: number;
  visibleRowCount: number;
  blankViewportPixels: number;
}

interface BrowserMetricsState {
  startTime: number;
  lastFrameTime: number | null;
  frameIntervals: TranscriptFrameIntervalMetric[];
  longTasks: TranscriptLongTaskMetric[];
  rafId: number | null;
  observer: PerformanceObserver | null;
}

interface BrowserMetricsWindow extends Window {
  __TRANSCRIPT_VIRTUALIZATION_METRICS__?: BrowserMetricsState;
}

interface PerformanceLongTaskAttributionLike extends PerformanceEntry {
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
  containerName?: string;
}

interface PerformanceLongTaskEntryLike extends PerformanceEntry {
  attribution?: PerformanceLongTaskAttributionLike[];
}

export interface TranscriptViewportSelectors {
  scroller: string;
  row: string;
}

export const DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS: TranscriptViewportSelectors =
  {
    scroller: '[data-testid="message-timeline-scroll"]',
    row: [
      "[data-transcript-row-id]",
      "[data-testid^='virtual-transcript-row-']",
      "[data-role='user-message']",
      "[data-role='assistant-message']",
    ].join(", "),
  };

export function filterTranscriptLongTasksForCollectionWindow(
  longTasks: readonly TranscriptLongTaskMetric[],
  startTime: number,
  endTime: number,
): TranscriptLongTaskMetric[] {
  return longTasks.filter(
    (task) => task.startTime >= startTime && task.startTime <= endTime,
  );
}

function calculatePercentile(
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

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function overlapsExclusionWindow(
  startTime: number,
  endTime: number,
  exclusionWindows: readonly TranscriptBrowserMetricExclusionWindow[],
) {
  return exclusionWindows.some((window) =>
    intervalsOverlap(startTime, endTime, window.startTime, window.endTime),
  );
}

export function filterTranscriptBrowserMetricsForProductionTiming(
  metrics: TranscriptBrowserMetrics,
  exclusionWindows: readonly TranscriptBrowserMetricExclusionWindow[],
): TranscriptBrowserMetrics {
  const normalizedWindows = exclusionWindows.filter(
    (window) =>
      Number.isFinite(window.startTime) &&
      Number.isFinite(window.endTime) &&
      window.endTime > window.startTime,
  );
  const frameIntervals = metrics.frameIntervals.filter(
    (interval) =>
      !overlapsExclusionWindow(
        interval.startTime,
        interval.endTime,
        normalizedWindows,
      ),
  );
  const longTasks = metrics.longTasks.filter((task) => {
    const taskEndTime = task.startTime + task.duration;
    return !overlapsExclusionWindow(
      task.startTime,
      taskEndTime,
      normalizedWindows,
    );
  });
  const frameDurations = frameIntervals.map((interval) => interval.duration);
  const droppedFrameCount = frameIntervals.filter(
    (interval) => interval.duration > 50,
  ).length;
  const frameCount = frameIntervals.length;

  return {
    ...metrics,
    durationMs: frameDurations.reduce((total, duration) => total + duration, 0),
    frameCount,
    droppedFrameCount,
    droppedFrameRate: frameCount === 0 ? 0 : droppedFrameCount / frameCount,
    frameIntervalP95Ms: calculatePercentile(frameDurations, 0.95),
    frameIntervals,
    longTasks,
    longTasksOver50Ms: longTasks.filter((task) => task.duration > 50).length,
  };
}

export async function startTranscriptBrowserMetrics(page: Page) {
  await page.evaluate(() => {
    const metricsWindow = window as BrowserMetricsWindow;
    const existing = metricsWindow.__TRANSCRIPT_VIRTUALIZATION_METRICS__;

    if (existing?.rafId != null) {
      cancelAnimationFrame(existing.rafId);
    }
    existing?.observer?.disconnect();

    const state: BrowserMetricsState = {
      startTime: performance.now(),
      lastFrameTime: null,
      frameIntervals: [],
      longTasks: [],
      rafId: null,
      observer: null,
    };

    const tick = (timestamp: number) => {
      if (state.lastFrameTime != null) {
        state.frameIntervals.push({
          startTime: state.lastFrameTime,
          endTime: timestamp,
          duration: timestamp - state.lastFrameTime,
        });
      }
      state.lastFrameTime = timestamp;
      state.rafId = requestAnimationFrame(tick);
    };

    if (typeof PerformanceObserver !== "undefined") {
      try {
        state.observer = new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            const longTaskEntry = entry as PerformanceLongTaskEntryLike;
            state.longTasks.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
              relativeStartTime: entry.startTime - state.startTime,
              attribution: Array.isArray(longTaskEntry.attribution)
                ? longTaskEntry.attribution.map((attribution) => ({
                    name: attribution.name,
                    entryType: attribution.entryType,
                    startTime: attribution.startTime,
                    duration: attribution.duration,
                    containerType: attribution.containerType,
                    containerSrc: attribution.containerSrc,
                    containerId: attribution.containerId,
                    containerName: attribution.containerName,
                  }))
                : [],
            });
          }
        });
        state.observer.observe({ type: "longtask", buffered: true });
      } catch (_error) {
        state.observer = null;
      }
    }

    state.rafId = requestAnimationFrame(tick);
    metricsWindow.__TRANSCRIPT_VIRTUALIZATION_METRICS__ = state;
  });
}

export async function readTranscriptBrowserMetricsClock(page: Page): Promise<{
  elapsedMs: number;
  now: number;
  startTime: number;
}> {
  return page.evaluate(() => {
    const metricsWindow = window as BrowserMetricsWindow;
    const startTime =
      metricsWindow.__TRANSCRIPT_VIRTUALIZATION_METRICS__?.startTime ??
      performance.now();
    const now = performance.now();
    return {
      elapsedMs: now - startTime,
      now,
      startTime,
    };
  });
}

export async function stopTranscriptBrowserMetrics(
  page: Page,
): Promise<TranscriptBrowserMetrics> {
  return page.evaluate(() => {
    const calculateBrowserPercentile = (
      values: readonly number[],
      percentileValue: number,
    ): number => {
      if (values.length === 0) {
        return 0;
      }

      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
      return sorted[index] ?? 0;
    };
    const metricsWindow = window as BrowserMetricsWindow;
    const state = metricsWindow.__TRANSCRIPT_VIRTUALIZATION_METRICS__;

    if (!state) {
      return {
        startTime: 0,
        endTime: 0,
        durationMs: 0,
        frameCount: 0,
        droppedFrameCount: 0,
        droppedFrameRate: 0,
        frameIntervalP95Ms: 0,
        frameIntervals: [],
        longTasks: [],
        longTasksOver50Ms: 0,
        ignoredLongTasksBeforeStart: 0,
      };
    }

    if (state.rafId != null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.observer?.disconnect();

    const droppedFrameCount = state.frameIntervals.filter(
      (interval) => interval.duration > 50,
    ).length;
    const frameCount = state.frameIntervals.length;
    const endTime = performance.now();
    const longTasksInCollectionWindow = state.longTasks.filter(
      (task) => task.startTime >= state.startTime && task.startTime <= endTime,
    );
    const frameDurations = state.frameIntervals.map(
      (interval) => interval.duration,
    );

    return {
      startTime: state.startTime,
      endTime,
      durationMs: endTime - state.startTime,
      frameCount,
      droppedFrameCount,
      droppedFrameRate: frameCount === 0 ? 0 : droppedFrameCount / frameCount,
      frameIntervalP95Ms: calculateBrowserPercentile(frameDurations, 0.95),
      frameIntervals: state.frameIntervals,
      longTasks: longTasksInCollectionWindow,
      longTasksOver50Ms: longTasksInCollectionWindow.filter(
        (task) => task.duration > 50,
      ).length,
      ignoredLongTasksBeforeStart:
        state.longTasks.length - longTasksInCollectionWindow.length,
    };
  });
}

export async function collectTranscriptViewportEvidence(
  page: Page,
  selectors: TranscriptViewportSelectors = DEFAULT_TRANSCRIPT_VIEWPORT_SELECTORS,
): Promise<TranscriptViewportEvidence> {
  return page.evaluate((viewportSelectors) => {
    const MAX_INTENTIONAL_ROW_GAP_PX = 24;
    const MAX_INTENTIONAL_EDGE_GAP_PX = 96;
    const scroller = document.querySelector(viewportSelectors.scroller);
    if (!(scroller instanceof HTMLElement)) {
      return {
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        mountedRowCount: 0,
        visibleRowCount: 0,
        blankViewportPixels: Number.POSITIVE_INFINITY,
      };
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll(viewportSelectors.row));
    const visibleIntervals = rows
      .map((row) => row.getBoundingClientRect())
      .map((rect) => ({
        top: Math.max(rect.top, scrollerRect.top),
        bottom: Math.min(rect.bottom, scrollerRect.bottom),
      }))
      .filter((interval) => interval.bottom > interval.top)
      .sort((left, right) => left.top - right.top);

    const mergedIntervals: { top: number; bottom: number }[] = [];
    for (const interval of visibleIntervals) {
      const previous = mergedIntervals.at(-1);
      if (!previous || interval.top > previous.bottom) {
        mergedIntervals.push({ ...interval });
        continue;
      }
      previous.bottom = Math.max(previous.bottom, interval.bottom);
    }

    let blankViewportPixels = scroller.clientHeight;
    if (mergedIntervals.length > 0) {
      blankViewportPixels = 0;
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
          scrollerRect.bottom -
            lastInterval.bottom -
            MAX_INTENTIONAL_EDGE_GAP_PX,
        );
      }
    }

    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      mountedRowCount: rows.length,
      visibleRowCount: visibleIntervals.length,
      blankViewportPixels,
    };
  }, selectors);
}
