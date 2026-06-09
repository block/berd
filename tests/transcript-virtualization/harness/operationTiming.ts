import type { Page } from "@playwright/test";
import type { TranscriptTimingSample } from "../../../src/features/chat/transcript/diagnostics";
import type { TranscriptBrowserMetricExclusionWindow } from "./browserMetrics";

const OPERATION_TIMING_SAMPLE_LIMIT = 500;

interface TranscriptOperationTimingInstrumentationOptions {
  scrollerSelector: string;
}

export interface TranscriptOperationTimingMetrics {
  startTime: number;
  endTime: number;
  durationMs: number;
  source: string;
  reactCommitSamples: readonly TranscriptTimingSample[];
  scrollHandlerSamples: readonly TranscriptTimingSample[];
  reactCommitSampleCount: number;
  scrollHandlerSampleCount: number;
  reactCommitP95Ms: number;
  scrollHandlerP95Ms: number;
}

interface TranscriptOperationTimingState {
  startTime: number;
  scrollerSelector: string;
  reactCommitSamples: TranscriptTimingSample[];
  scrollHandlerSamples: TranscriptTimingSample[];
  listenerWrappers: WeakMap<
    EventListenerOrEventListenerObject,
    EventListenerOrEventListenerObject
  >;
  installed: boolean;
}

interface TranscriptOperationTimingWindow extends Window {
  __TRANSCRIPT_OPERATION_TIMING__?: TranscriptOperationTimingState;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHookLike;
}

interface ReactDevtoolsHookLike {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => unknown;
  onCommitFiberUnmount?: (...args: unknown[]) => unknown;
  isDisabled?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function normalizeTranscriptTimingSamples(
  value: unknown,
): TranscriptTimingSample[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const samples: TranscriptTimingSample[] = [];
  for (const sample of value) {
    if (!isRecord(sample)) {
      continue;
    }

    const { startTime, endTime, durationMs, source } = sample;
    if (
      typeof startTime !== "number" ||
      !Number.isFinite(startTime) ||
      typeof endTime !== "number" ||
      !Number.isFinite(endTime) ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      endTime < startTime ||
      durationMs < 0
    ) {
      continue;
    }

    samples.push({
      startTime,
      endTime,
      durationMs,
      ...(typeof source === "string" ? { source } : {}),
    });
  }

  return samples;
}

function createTranscriptOperationTimingMetrics({
  startTime,
  endTime,
  source,
  reactCommitSamples,
  scrollHandlerSamples,
}: {
  startTime: number;
  endTime: number;
  source: string;
  reactCommitSamples: readonly TranscriptTimingSample[];
  scrollHandlerSamples: readonly TranscriptTimingSample[];
}): TranscriptOperationTimingMetrics {
  return {
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    source,
    reactCommitSamples,
    scrollHandlerSamples,
    reactCommitSampleCount: reactCommitSamples.length,
    scrollHandlerSampleCount: scrollHandlerSamples.length,
    reactCommitP95Ms: calculatePercentile(
      reactCommitSamples.map((sample) => sample.durationMs),
      0.95,
    ),
    scrollHandlerP95Ms: calculatePercentile(
      scrollHandlerSamples.map((sample) => sample.durationMs),
      0.95,
    ),
  };
}

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function transcriptTimingSampleOverlapsExclusionWindow(
  sample: TranscriptTimingSample,
  exclusionWindows: readonly TranscriptBrowserMetricExclusionWindow[],
) {
  return exclusionWindows.some((window) =>
    intervalsOverlap(
      sample.startTime,
      sample.endTime,
      window.startTime,
      window.endTime,
    ),
  );
}

export function filterTranscriptOperationTimingMetricsForProductionTiming(
  metrics: TranscriptOperationTimingMetrics,
  exclusionWindows: readonly TranscriptBrowserMetricExclusionWindow[],
): TranscriptOperationTimingMetrics {
  const normalizedWindows = exclusionWindows.filter(
    (window) =>
      Number.isFinite(window.startTime) &&
      Number.isFinite(window.endTime) &&
      window.endTime > window.startTime,
  );

  return createTranscriptOperationTimingMetrics({
    startTime: metrics.startTime,
    endTime: metrics.endTime,
    source: `${metrics.source}:fixture-operation-filtered`,
    reactCommitSamples: metrics.reactCommitSamples.filter(
      (sample) =>
        !transcriptTimingSampleOverlapsExclusionWindow(
          sample,
          normalizedWindows,
        ),
    ),
    scrollHandlerSamples: metrics.scrollHandlerSamples.filter(
      (sample) =>
        !transcriptTimingSampleOverlapsExclusionWindow(
          sample,
          normalizedWindows,
        ),
    ),
  });
}

export function readTranscriptOperationTimingMetricsFromDiagnostics(
  diagnostics: Record<string, unknown> | null,
  startTime: number,
  endTime: number,
): TranscriptOperationTimingMetrics {
  const isInsideCollectionWindow = (sample: TranscriptTimingSample) =>
    sample.startTime >= startTime && sample.endTime <= endTime;

  return createTranscriptOperationTimingMetrics({
    startTime,
    endTime,
    source: "production-diagnostics",
    reactCommitSamples: normalizeTranscriptTimingSamples(
      diagnostics?.reactCommitSamples,
    ).filter(isInsideCollectionWindow),
    scrollHandlerSamples: normalizeTranscriptTimingSamples(
      diagnostics?.scrollHandlerSamples,
    ).filter(isInsideCollectionWindow),
  });
}

export function preferDiagnosticTranscriptOperationTimingMetrics(
  diagnosticsMetrics: TranscriptOperationTimingMetrics,
  harnessMetrics: TranscriptOperationTimingMetrics,
): TranscriptOperationTimingMetrics {
  const reactCommitSamples =
    diagnosticsMetrics.reactCommitSamples.length > 0
      ? diagnosticsMetrics.reactCommitSamples
      : harnessMetrics.reactCommitSamples;
  const scrollHandlerSamples =
    diagnosticsMetrics.scrollHandlerSamples.length > 0
      ? diagnosticsMetrics.scrollHandlerSamples
      : harnessMetrics.scrollHandlerSamples;
  const sourceParts = [
    diagnosticsMetrics.reactCommitSamples.length > 0 ||
    diagnosticsMetrics.scrollHandlerSamples.length > 0
      ? diagnosticsMetrics.source
      : null,
    harnessMetrics.reactCommitSamples.length > 0 ||
    harnessMetrics.scrollHandlerSamples.length > 0
      ? harnessMetrics.source
      : null,
  ].filter((source): source is string => source != null);

  return createTranscriptOperationTimingMetrics({
    startTime: harnessMetrics.startTime,
    endTime: harnessMetrics.endTime,
    source: sourceParts.length > 0 ? sourceParts.join("+") : "none",
    reactCommitSamples,
    scrollHandlerSamples,
  });
}

export async function installTranscriptOperationTimingInstrumentation(
  page: Page,
  options: TranscriptOperationTimingInstrumentationOptions,
) {
  if (process.env.TRANSCRIPT_OPERATION_TIMING_DISABLED === "1") {
    return;
  }

  await page.addInitScript(
    ({ sampleLimit, scrollerSelector }) => {
      interface ReactFiberLike {
        actualDuration?: number;
        child?: ReactFiberLike | null;
        memoizedProps?: unknown;
        pendingProps?: unknown;
        sibling?: ReactFiberLike | null;
      }

      const timingWindow = window as TranscriptOperationTimingWindow;
      const state =
        timingWindow.__TRANSCRIPT_OPERATION_TIMING__ ??
        ({
          startTime: performance.now(),
          scrollerSelector,
          reactCommitSamples: [],
          scrollHandlerSamples: [],
          listenerWrappers: new WeakMap(),
          installed: false,
        } satisfies TranscriptOperationTimingState);

      state.scrollerSelector = scrollerSelector;
      timingWindow.__TRANSCRIPT_OPERATION_TIMING__ = state;

      const pushSample = (
        samples: TranscriptTimingSample[],
        sample: TranscriptTimingSample,
      ) => {
        if (
          !Number.isFinite(sample.startTime) ||
          !Number.isFinite(sample.endTime) ||
          !Number.isFinite(sample.durationMs) ||
          sample.endTime < sample.startTime ||
          sample.durationMs < 0
        ) {
          return;
        }

        samples.push(sample);
        if (samples.length > sampleLimit) {
          samples.splice(0, samples.length - sampleLimit);
        }
      };

      const getProfilerId = (fiber: ReactFiberLike): string | null => {
        const props =
          typeof fiber.memoizedProps === "object" && fiber.memoizedProps != null
            ? fiber.memoizedProps
            : fiber.pendingProps;
        if (typeof props !== "object" || props == null) {
          return null;
        }

        const id = (props as { id?: unknown }).id;
        return typeof id === "string" ? id : null;
      };

      const recordProfilerFiberSamples = (root: unknown) => {
        const rootFiber = (root as { current?: ReactFiberLike } | null)
          ?.current;
        if (!rootFiber) {
          return;
        }

        const commitTime = performance.now();
        const stack: ReactFiberLike[] = [rootFiber];
        const seen = new Set<ReactFiberLike>();

        while (stack.length > 0) {
          const fiber = stack.pop();
          if (!fiber || seen.has(fiber)) {
            continue;
          }
          seen.add(fiber);

          if (fiber.sibling) {
            stack.push(fiber.sibling);
          }
          if (fiber.child) {
            stack.push(fiber.child);
          }

          if (getProfilerId(fiber) !== "VirtualMessageTimeline") {
            continue;
          }

          const durationMs = fiber.actualDuration;
          if (
            typeof durationMs !== "number" ||
            !Number.isFinite(durationMs) ||
            durationMs <= 0
          ) {
            continue;
          }

          pushSample(state.reactCommitSamples, {
            startTime: Math.max(0, commitTime - durationMs),
            endTime: commitTime,
            durationMs,
            source: "react-devtools-profiler-fiber",
          });
        }
      };

      const installReactDevtoolsHook = () => {
        const existingHook = timingWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        const hook =
          existingHook ??
          ({
            supportsFiber: true,
            renderers: new Map<number, unknown>(),
            inject(renderer: unknown) {
              const rendererId = (this.renderers?.size ?? 0) + 1;
              this.renderers?.set(rendererId, renderer);
              return rendererId;
            },
            onCommitFiberRoot() {
              return undefined;
            },
            onCommitFiberUnmount() {
              return undefined;
            },
          } satisfies ReactDevtoolsHookLike);

        hook.supportsFiber = true;
        hook.renderers ??= new Map<number, unknown>();
        hook.inject ??= function inject(renderer: unknown) {
          const rendererId = (this.renderers?.size ?? 0) + 1;
          this.renderers?.set(rendererId, renderer);
          return rendererId;
        };

        const previousOnCommitFiberRoot = hook.onCommitFiberRoot?.bind(hook);
        hook.onCommitFiberRoot = (...args: unknown[]) => {
          try {
            recordProfilerFiberSamples(args[1]);
          } catch (_error) {
            // The hook is proof-only instrumentation and must not affect React.
          }
          return previousOnCommitFiberRoot?.(...args);
        };
        hook.onCommitFiberUnmount ??= () => undefined;

        timingWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
      };

      const matchesScroller = (value: unknown): boolean => {
        if (!(value instanceof Element)) {
          return false;
        }

        try {
          return (
            value.matches(state.scrollerSelector) ||
            value.closest(state.scrollerSelector) != null
          );
        } catch (_error) {
          return false;
        }
      };

      const shouldRecordScrollEvent = (
        event: Event,
        currentTarget: EventTarget,
      ) =>
        matchesScroller(event.target) ||
        matchesScroller(event.currentTarget) ||
        matchesScroller(currentTarget);

      const originalAddEventListener = EventTarget.prototype.addEventListener;
      const originalRemoveEventListener =
        EventTarget.prototype.removeEventListener;

      const wrapScrollListener = (
        listener: EventListenerOrEventListenerObject,
      ): EventListenerOrEventListenerObject => {
        const existingWrapper = state.listenerWrappers.get(listener);
        if (existingWrapper) {
          return existingWrapper;
        }

        if (typeof listener === "function") {
          const wrapped: EventListener = function wrappedScrollListener(
            this: EventTarget,
            event,
          ) {
            const shouldRecord = shouldRecordScrollEvent(event, this);
            const startTime = performance.now();
            try {
              return listener.call(this, event);
            } finally {
              if (shouldRecord) {
                const endTime = performance.now();
                pushSample(state.scrollHandlerSamples, {
                  startTime,
                  endTime,
                  durationMs: endTime - startTime,
                  source: "scroll-listener-wrapper",
                });
              }
            }
          };
          state.listenerWrappers.set(listener, wrapped);
          return wrapped;
        }

        const wrapped: EventListenerObject = {
          handleEvent(event) {
            const currentTarget = event.currentTarget ?? event.target;
            const shouldRecord =
              currentTarget != null &&
              shouldRecordScrollEvent(event, currentTarget);
            const startTime = performance.now();
            try {
              return listener.handleEvent(event);
            } finally {
              if (shouldRecord) {
                const endTime = performance.now();
                pushSample(state.scrollHandlerSamples, {
                  startTime,
                  endTime,
                  durationMs: endTime - startTime,
                  source: "scroll-listener-wrapper",
                });
              }
            }
          },
        };
        state.listenerWrappers.set(listener, wrapped);
        return wrapped;
      };

      if (!state.installed) {
        installReactDevtoolsHook();

        EventTarget.prototype.addEventListener = function addEventListener(
          this: EventTarget,
          type,
          listener,
          options,
        ) {
          if (type !== "scroll" || listener == null) {
            return originalAddEventListener.call(this, type, listener, options);
          }

          return originalAddEventListener.call(
            this,
            type,
            wrapScrollListener(listener),
            options,
          );
        };

        EventTarget.prototype.removeEventListener =
          function removeEventListener(
            this: EventTarget,
            type,
            listener,
            options,
          ) {
            if (type !== "scroll" || listener == null) {
              return originalRemoveEventListener.call(
                this,
                type,
                listener,
                options,
              );
            }

            return originalRemoveEventListener.call(
              this,
              type,
              state.listenerWrappers.get(listener) ?? listener,
              options,
            );
          };

        state.installed = true;
      }
    },
    {
      sampleLimit: OPERATION_TIMING_SAMPLE_LIMIT,
      scrollerSelector: options.scrollerSelector,
    },
  );
}

export async function resetTranscriptOperationTiming(page: Page) {
  await page.evaluate(() => {
    const timingWindow = window as TranscriptOperationTimingWindow;
    const state = timingWindow.__TRANSCRIPT_OPERATION_TIMING__;

    if (!state) {
      return;
    }

    state.startTime = performance.now();
    state.reactCommitSamples = [];
    state.scrollHandlerSamples = [];
  });
}

export async function collectTranscriptOperationTimingMetrics(
  page: Page,
): Promise<TranscriptOperationTimingMetrics> {
  const rawMetrics = await page.evaluate(() => {
    const timingWindow = window as TranscriptOperationTimingWindow;
    const state = timingWindow.__TRANSCRIPT_OPERATION_TIMING__;
    const endTime = performance.now();

    if (!state) {
      return {
        startTime: 0,
        endTime: 0,
        source: "none",
        reactCommitSamples: [],
        scrollHandlerSamples: [],
      };
    }

    const isInsideCollectionWindow = (sample: TranscriptTimingSample) =>
      sample.startTime >= state.startTime && sample.endTime <= endTime;

    return {
      startTime: state.startTime,
      endTime,
      source: "playwright-operation-timing",
      reactCommitSamples: state.reactCommitSamples.filter(
        isInsideCollectionWindow,
      ),
      scrollHandlerSamples: state.scrollHandlerSamples.filter(
        isInsideCollectionWindow,
      ),
    };
  });

  return createTranscriptOperationTimingMetrics(rawMetrics);
}
