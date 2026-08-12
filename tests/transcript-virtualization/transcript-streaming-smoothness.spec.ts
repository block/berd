import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptFixture,
  type TranscriptHarnessOperation,
  type TranscriptRendererMode,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import { loadTranscriptRenderer } from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;

interface TranscriptHarnessWindow extends Window {
  __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: {
    applyOperation?: (
      operation: TranscriptHarnessOperation,
    ) => void | Promise<void>;
    collectDiagnostics?: () =>
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
  };
}

interface StreamingSmoothnessSample {
  elapsedMs: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  streamingChunkApplyCount: number;
  activeStreamingOperations: number;
  scrollCorrectionCount: number;
  measurementAcceptedCount: number;
  fragmentRows: number;
  streamingTailRows: number;
  activeTop: number | null;
  activeBottom: number | null;
  activeHeight: number | null;
  activeTailTop: number | null;
  activeTailBottom: number | null;
  activeTailHeight: number | null;
  activeTailVirtualSize: number | null;
  activeTailBlankAfterContent: number | null;
}

interface StreamingSmoothnessDelta {
  elapsedMs: number;
  scrollTopDelta: number;
  scrollHeightDelta: number;
  distanceFromBottomDelta: number;
  activeBottomDelta: number;
  activeTailBottomDelta: number;
  activeHeightDelta: number;
  chunkDelta: number;
}

interface StreamingSmoothnessSummary {
  rendererMode: TranscriptRendererMode;
  sampleCount: number;
  activeSampleCount: number;
  activeDurationMs: number;
  firstChunkCount: number;
  lastChunkCount: number;
  chunkAdvanceCount: number;
  maxDistanceFromBottom: number;
  p95DistanceFromBottom: number;
  maxScrollTopDelta: number;
  p95ScrollTopDelta: number;
  maxScrollHeightDelta: number;
  p95ScrollHeightDelta: number;
  maxDistanceFromBottomDelta: number;
  p95DistanceFromBottomDelta: number;
  maxActiveBottomDelta: number;
  p95ActiveBottomDelta: number;
  maxActiveTailBottomDelta: number;
  p95ActiveTailBottomDelta: number;
  maxActiveHeightDelta: number;
  p95ActiveHeightDelta: number;
  maxActiveTailBlankAfterContent: number;
  maxChunkScrollTopDelta: number;
  maxChunkScrollHeightDelta: number;
  maxFragmentRows: number;
  maxStreamingTailRows: number;
  lastScrollCorrectionCount: number;
  lastMeasurementAcceptedCount: number;
}

async function settleFrames(page: Page, count = 2) {
  await page.evaluate(async (frameCount) => {
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    for (let index = 0; index < frameCount; index += 1) {
      await waitForFrame();
    }
  }, count);
}

async function applyHarnessOperation(
  page: Page,
  operation: TranscriptHarnessOperation,
) {
  await page.evaluate(async (nextOperation) => {
    await (
      window as TranscriptHarnessWindow
    ).__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.applyOperation?.(nextOperation);
  }, operation);
  await settleFrames(page);
}

async function pinTranscriptToBottom(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector(
      '[data-testid="message-timeline-scroll"]',
    );
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("message timeline scroller was not mounted");
    }

    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settleFrames(page, 2);
}

function percentile(values: readonly number[], percentileValue: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function max(values: readonly number[]) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function buildBottomPinnedLongMarkdownFixture(): TranscriptFixture {
  const fixture = buildTranscriptFixture("streaming-scrollback-long-markdown");
  const session = fixture.sessions[0];
  const assistantId = session.streamingMessageId;

  if (!assistantId) {
    throw new Error("streaming smoothness fixture is missing assistant id");
  }

  return {
    ...fixture,
    description:
      "Bottom-pinned active stream that starts short, then grows into long markdown.",
    sessions: [
      {
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: [
                  {
                    type: "text" as const,
                    text: [
                      "# Streaming Smoothness Probe",
                      "",
                      "Initial response text before long markdown token delivery.",
                    ].join("\n"),
                  },
                ],
                metadata: {
                  ...message.metadata,
                  userVisible: true,
                  agentVisible: true,
                  completionStatus: "inProgress",
                },
              }
            : message,
        ),
      },
    ],
  };
}

async function collectStreamingSmoothnessSamples(
  page: Page,
  messageId: string,
  durationMs: number,
): Promise<StreamingSmoothnessSample[]> {
  return page.evaluate(
    async ({ targetMessageId, sampleDurationMs }) => {
      const samples: StreamingSmoothnessSample[] = [];
      const startedAt = performance.now();
      const escapedMessageId = CSS.escape(targetMessageId);
      const waitForFrame = () =>
        new Promise<number>((resolve) => requestAnimationFrame(resolve));

      while (performance.now() - startedAt <= sampleDurationMs) {
        await waitForFrame();

        const scroller = document.querySelector(
          '[data-testid="message-timeline-scroll"]',
        );
        const harnessWindow = window as TranscriptHarnessWindow;
        const diagnostics =
          (await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.()) ??
          {};
        const list = document.querySelector(
          '[data-testid="virtual-message-timeline-list"]',
        );

        if (!(scroller instanceof HTMLElement)) {
          samples.push({
            elapsedMs: performance.now() - startedAt,
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            distanceFromBottom: 0,
            streamingChunkApplyCount: Number(
              diagnostics.streamingChunkApplyCount ?? 0,
            ),
            activeStreamingOperations: Number(
              diagnostics.activeStreamingOperations ?? 0,
            ),
            scrollCorrectionCount: Number(
              diagnostics.scrollCorrectionCount ?? 0,
            ),
            measurementAcceptedCount: Number(
              diagnostics.measurementAcceptedCount ?? 0,
            ),
            fragmentRows: 0,
            streamingTailRows: 0,
            activeTop: null,
            activeBottom: null,
            activeHeight: null,
            activeTailTop: null,
            activeTailBottom: null,
            activeTailHeight: null,
            activeTailVirtualSize: null,
            activeTailBlankAfterContent: null,
          });
          continue;
        }

        const scrollerRect = scroller.getBoundingClientRect();
        const activeRows = Array.from(
          scroller.querySelectorAll<HTMLElement>(
            [
              `[data-transcript-message-id="${escapedMessageId}"]`,
              `[data-virtual-row-message-id="${escapedMessageId}"]`,
              `[data-virtual-row-id$="message:${escapedMessageId}"]`,
              `[data-virtual-row-id$="${escapedMessageId}"]`,
            ].join(","),
          ),
        )
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return {
              row,
              top: rect.top - scrollerRect.top,
              bottom: rect.bottom - scrollerRect.top,
              height: rect.height,
            };
          })
          .filter(
            (entry) => entry.bottom > 0 && entry.top < scroller.clientHeight,
          )
          .sort((left, right) => left.top - right.top);
        const activeTail =
          activeRows.find(
            ({ row }) => row.dataset.virtualRowStreamingTail === "true",
          ) ?? activeRows.at(-1);
        const activeTop =
          activeRows.length > 0
            ? Math.min(...activeRows.map((entry) => entry.top))
            : null;
        const activeBottom =
          activeRows.length > 0
            ? Math.max(...activeRows.map((entry) => entry.bottom))
            : null;
        const activeHeight =
          activeTop != null && activeBottom != null
            ? activeBottom - activeTop
            : null;
        const activeTailVirtualSize =
          activeTail?.row.dataset.virtualRowVirtualSize != null
            ? Number(activeTail.row.dataset.virtualRowVirtualSize)
            : null;
        const activeTailChildBottom =
          activeTail != null
            ? Math.max(
                activeTail.top,
                ...Array.from(activeTail.row.children)
                  .filter(
                    (child): child is HTMLElement =>
                      child instanceof HTMLElement,
                  )
                  .map((child) => {
                    const rect = child.getBoundingClientRect();
                    return rect.bottom - scrollerRect.top;
                  }),
              )
            : null;
        const activeTailBlankAfterContent =
          activeTail != null && activeTailChildBottom != null
            ? Math.max(0, activeTail.bottom - activeTailChildBottom)
            : null;

        samples.push({
          elapsedMs: performance.now() - startedAt,
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          distanceFromBottom:
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          streamingChunkApplyCount: Number(
            diagnostics.streamingChunkApplyCount ?? 0,
          ),
          activeStreamingOperations: Number(
            diagnostics.activeStreamingOperations ?? 0,
          ),
          scrollCorrectionCount: Number(diagnostics.scrollCorrectionCount ?? 0),
          measurementAcceptedCount: Number(
            diagnostics.measurementAcceptedCount ?? 0,
          ),
          fragmentRows:
            list instanceof HTMLElement
              ? Number(list.dataset.virtualCompletedStreamingFragmentRows ?? 0)
              : 0,
          streamingTailRows:
            list instanceof HTMLElement
              ? Number(list.dataset.virtualStreamingTailRows ?? 0)
              : 0,
          activeTop,
          activeBottom,
          activeHeight,
          activeTailTop: activeTail?.top ?? null,
          activeTailBottom: activeTail?.bottom ?? null,
          activeTailHeight: activeTail?.height ?? null,
          activeTailVirtualSize: Number.isFinite(activeTailVirtualSize)
            ? activeTailVirtualSize
            : null,
          activeTailBlankAfterContent,
        });
      }

      return samples;
    },
    { targetMessageId: messageId, sampleDurationMs: durationMs },
  );
}

function summarizeSmoothness(
  rendererMode: TranscriptRendererMode,
  samples: readonly StreamingSmoothnessSample[],
): StreamingSmoothnessSummary {
  const activeSamples = samples.filter(
    (sample) =>
      sample.activeStreamingOperations > 0 &&
      sample.streamingChunkApplyCount >= 2,
  );
  const deltas: StreamingSmoothnessDelta[] = activeSamples
    .slice(1)
    .map((sample, index) => {
      const previous = activeSamples[index] as StreamingSmoothnessSample;
      return {
        elapsedMs: sample.elapsedMs,
        scrollTopDelta: Math.abs(sample.scrollTop - previous.scrollTop),
        scrollHeightDelta: Math.abs(
          sample.scrollHeight - previous.scrollHeight,
        ),
        distanceFromBottomDelta: Math.abs(
          sample.distanceFromBottom - previous.distanceFromBottom,
        ),
        activeBottomDelta:
          sample.activeBottom == null || previous.activeBottom == null
            ? 0
            : Math.abs(sample.activeBottom - previous.activeBottom),
        activeTailBottomDelta:
          sample.activeTailBottom == null || previous.activeTailBottom == null
            ? 0
            : Math.abs(sample.activeTailBottom - previous.activeTailBottom),
        activeHeightDelta:
          sample.activeHeight == null || previous.activeHeight == null
            ? 0
            : Math.abs(sample.activeHeight - previous.activeHeight),
        chunkDelta:
          sample.streamingChunkApplyCount - previous.streamingChunkApplyCount,
      };
    });
  const chunkDeltas = deltas.filter((delta) => delta.chunkDelta > 0);
  const distancesFromBottom = activeSamples.map(
    (sample) => sample.distanceFromBottom,
  );
  const firstActive = activeSamples[0];
  const lastActive = activeSamples.at(-1);
  const activeTailBlankAfterContent = activeSamples.flatMap((sample) =>
    sample.activeTailBlankAfterContent == null
      ? []
      : [sample.activeTailBlankAfterContent],
  );

  return {
    rendererMode,
    sampleCount: samples.length,
    activeSampleCount: activeSamples.length,
    activeDurationMs:
      firstActive && lastActive
        ? lastActive.elapsedMs - firstActive.elapsedMs
        : 0,
    firstChunkCount: firstActive?.streamingChunkApplyCount ?? 0,
    lastChunkCount: lastActive?.streamingChunkApplyCount ?? 0,
    chunkAdvanceCount: chunkDeltas.length,
    maxDistanceFromBottom: max(distancesFromBottom),
    p95DistanceFromBottom: percentile(distancesFromBottom, 0.95),
    maxScrollTopDelta: max(deltas.map((delta) => delta.scrollTopDelta)),
    p95ScrollTopDelta: percentile(
      deltas.map((delta) => delta.scrollTopDelta),
      0.95,
    ),
    maxScrollHeightDelta: max(deltas.map((delta) => delta.scrollHeightDelta)),
    p95ScrollHeightDelta: percentile(
      deltas.map((delta) => delta.scrollHeightDelta),
      0.95,
    ),
    maxDistanceFromBottomDelta: max(
      deltas.map((delta) => delta.distanceFromBottomDelta),
    ),
    p95DistanceFromBottomDelta: percentile(
      deltas.map((delta) => delta.distanceFromBottomDelta),
      0.95,
    ),
    maxActiveBottomDelta: max(deltas.map((delta) => delta.activeBottomDelta)),
    p95ActiveBottomDelta: percentile(
      deltas.map((delta) => delta.activeBottomDelta),
      0.95,
    ),
    maxActiveTailBottomDelta: max(
      deltas.map((delta) => delta.activeTailBottomDelta),
    ),
    p95ActiveTailBottomDelta: percentile(
      deltas.map((delta) => delta.activeTailBottomDelta),
      0.95,
    ),
    maxActiveHeightDelta: max(deltas.map((delta) => delta.activeHeightDelta)),
    p95ActiveHeightDelta: percentile(
      deltas.map((delta) => delta.activeHeightDelta),
      0.95,
    ),
    maxActiveTailBlankAfterContent: max(activeTailBlankAfterContent),
    maxChunkScrollTopDelta: max(
      chunkDeltas.map((delta) => delta.scrollTopDelta),
    ),
    maxChunkScrollHeightDelta: max(
      chunkDeltas.map((delta) => delta.scrollHeightDelta),
    ),
    maxFragmentRows: max(activeSamples.map((sample) => sample.fragmentRows)),
    maxStreamingTailRows: max(
      activeSamples.map((sample) => sample.streamingTailRows),
    ),
    lastScrollCorrectionCount: lastActive?.scrollCorrectionCount ?? 0,
    lastMeasurementAcceptedCount: lastActive?.measurementAcceptedCount ?? 0,
  };
}

async function attachSmoothnessResult(
  testInfo: TestInfo,
  result: {
    legacy: StreamingSmoothnessSummary;
    virtual: StreamingSmoothnessSummary;
    samples: Record<TranscriptRendererMode, StreamingSmoothnessSample[]>;
  },
) {
  await testInfo.attach("streaming-smoothness-ab.json", {
    contentType: "application/json",
    body: JSON.stringify(result, null, 2),
  });
}

async function collectRendererSmoothness(
  page: Page,
  rendererMode: TranscriptRendererMode,
) {
  const fixture = buildBottomPinnedLongMarkdownFixture();
  const session = fixture.sessions[0];
  const assistantId = session.streamingMessageId;
  const restoreOperation = fixture.operations.find(
    (operation) => operation.kind === "restore",
  );
  const startOperation = fixture.operations.find(
    (operation) => operation.kind === "startStreamingText",
  );

  if (!assistantId || !restoreOperation || !startOperation) {
    throw new Error("streaming smoothness fixture is missing proof inputs");
  }

  await loadTranscriptRenderer(page, {
    rendererUrl,
    rendererMode,
    fixture,
  });
  await applyHarnessOperation(page, restoreOperation);
  await applyHarnessOperation(page, startOperation);
  await pinTranscriptToBottom(page);

  const samples = await collectStreamingSmoothnessSamples(
    page,
    assistantId,
    2_200,
  );
  const summary = summarizeSmoothness(rendererMode, samples);
  return { samples, summary };
}

test.describe("transcript streaming smoothness A/B", () => {
  test("virtual pinned-bottom streaming cadence stays close to legacy", async ({
    browser,
  }, testInfo) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "streaming smoothness A/B requires the real renderer bridge",
    );

    const legacyPage = await browser.newPage();
    const virtualPage = await browser.newPage();
    try {
      const legacy = await collectRendererSmoothness(legacyPage, "legacy");
      const virtual = await collectRendererSmoothness(virtualPage, "virtual");
      await attachSmoothnessResult(testInfo, {
        legacy: legacy.summary,
        virtual: virtual.summary,
        samples: {
          legacy: legacy.samples,
          virtual: virtual.samples,
        },
      });
      expect(
        legacy.summary.activeSampleCount,
        "legacy run must capture active streaming frames",
      ).toBeGreaterThanOrEqual(30);
      expect(
        virtual.summary.activeSampleCount,
        "virtual run must capture active streaming frames",
      ).toBeGreaterThanOrEqual(30);
      expect(
        legacy.summary.lastChunkCount - legacy.summary.firstChunkCount,
        "legacy stream should advance during the sample window",
      ).toBeGreaterThanOrEqual(12);
      expect(
        virtual.summary.lastChunkCount - virtual.summary.firstChunkCount,
        "virtual stream should advance during the sample window",
      ).toBeGreaterThanOrEqual(12);
      expect(
        legacy.samples.find((sample) => sample.activeStreamingOperations > 0)
          ?.distanceFromBottom ?? Number.POSITIVE_INFINITY,
        "legacy capture should begin pinned to bottom",
      ).toBeLessThanOrEqual(8);
      expect(
        virtual.samples.find((sample) => sample.activeStreamingOperations > 0)
          ?.distanceFromBottom ?? Number.POSITIVE_INFINITY,
        "virtual capture should begin pinned to bottom",
      ).toBeLessThanOrEqual(8);

      expect(
        virtual.summary.p95ScrollTopDelta,
        "virtual p95 scrollTop movement per frame should stay close to legacy",
      ).toBeLessThanOrEqual(legacy.summary.p95ScrollTopDelta + 8);
      expect(
        virtual.summary.p95DistanceFromBottomDelta,
        "virtual p95 bottom-distance movement per frame should stay close to legacy",
      ).toBeLessThanOrEqual(legacy.summary.p95DistanceFromBottomDelta + 8);
      expect(
        virtual.summary.maxChunkScrollHeightDelta,
        "virtual per-chunk scrollHeight pop should not substantially exceed legacy",
      ).toBeLessThanOrEqual(
        Math.max(legacy.summary.maxChunkScrollHeightDelta * 1.25, 32),
      );
      expect(
        virtual.summary.maxActiveTailBlankAfterContent,
        "virtual streaming row should not reserve a large blank area below rendered markdown",
      ).toBeLessThanOrEqual(
        Math.max(legacy.summary.maxActiveTailBlankAfterContent + 48, 120),
      );
    } finally {
      await legacyPage.close();
      await virtualPage.close();
    }
  });
});
