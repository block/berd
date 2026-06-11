import { expect, test, type Page } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptHarnessOperation,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import {
  collectTranscriptScrollSnapshot,
  collectTranscriptStreamingScrollbackEvidence,
  collectTranscriptVirtualTimelineDomCounters,
  loadTranscriptRenderer,
} from "./harness/rendererHarness";
import { collectTranscriptViewportEvidence } from "./harness/browserMetrics";
import { DOM_BOUNDED_FULL_HISTORY_THRESHOLDS } from "./harness/thresholds";

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

async function scrollBackInsideActiveResponse(page: Page, messageId: string) {
  await page.evaluate(async (targetMessageId) => {
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scroller = document.querySelector(
      '[data-testid="message-timeline-scroll"]',
    );
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("message timeline scroller was not mounted");
    }

    const escapedMessageId = CSS.escape(targetMessageId);
    const streamingTail =
      scroller.querySelector(
        `[data-virtual-row-message-id="${escapedMessageId}"][data-virtual-row-streaming-tail="true"]`,
      ) ??
      scroller.querySelector(
        `[data-transcript-message-id="${escapedMessageId}"]`,
      );
    if (!(streamingTail instanceof HTMLElement)) {
      throw new Error("active streaming response row was not mounted");
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const tailRect = streamingTail.getBoundingClientRect();
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop +
        tailRect.top -
        scrollerRect.top -
        scroller.clientHeight * 0.45,
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitForFrame();

    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop - scroller.clientHeight * 1.6,
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitForFrame();
  }, messageId);
  await settleFrames(page);
}

async function wheelInsideActiveResponse(page: Page, deltaY: number) {
  const scroller = page.getByTestId("message-timeline-scroll");
  await scroller.hover();
  const before = await collectTranscriptScrollSnapshot(page);
  await page.mouse.wheel(0, deltaY);
  await settleFrames(page, 3);
  const after = await collectTranscriptScrollSnapshot(page);

  return { before, after };
}

function buildStreamingStartsShortFixture() {
  const fixture = buildTranscriptFixture("streaming-scrollback-long-markdown");
  const session = fixture.sessions[0];
  const assistantId = session.streamingMessageId;
  if (!assistantId) {
    throw new Error("streaming scrollback fixture is missing assistant id");
  }

  const assistant = session.messages.find(
    (message) => message.id === assistantId,
  );
  const textBlock = assistant?.content.find((block) => block.type === "text");
  if (textBlock?.type !== "text") {
    throw new Error("streaming scrollback fixture is missing assistant text");
  }

  textBlock.text =
    "# Scrollback Stress Test\n\nInitial response text before token delivery.";

  for (const operation of fixture.operations) {
    if (operation.kind === "startStreamingText") {
      operation.chunkIntervalMs = 60;
    }
  }

  return fixture;
}

function buildStreamingCancelRemountFixture() {
  const fixture = buildTranscriptFixture("streaming-scrollback-long-markdown");
  const primarySession = fixture.sessions[0];
  if (!primarySession) {
    throw new Error("streaming cancel fixture is missing primary session");
  }
  for (const operation of fixture.operations) {
    if (operation.kind === "startStreamingText") {
      operation.chunkIntervalMs = 60;
    }
  }

  return {
    ...fixture,
    sessions: [
      primarySession,
      {
        sessionId: "streaming-cancel-remount-other",
        title: "Other session",
        streamingMessageId: null,
        messages: [
          {
            id: "streaming-cancel-remount-other-user",
            role: "user" as const,
            created: Date.UTC(2026, 5, 4, 15, 0, 0),
            content: [
              {
                type: "text" as const,
                text: "Other session while the stopped transcript remounts.",
              },
            ],
            metadata: { userVisible: true },
          },
        ],
      },
    ],
  };
}

function buildPinnedBottomStreamingFixture() {
  const fixture = buildTranscriptFixture("visual-spacing-date-footer");
  const session = fixture.sessions[0];
  const assistantId = "spacing-tail-assistant";
  const streamId = "pinned-bottom-proof";
  if (!session) {
    throw new Error("pinned-bottom fixture is missing primary session");
  }

  const paragraph = [
    "The afternoon light settled softly across the room, turning ordinary objects into small points of warmth and shadow.",
    "A half-finished cup of coffee sat beside an open notebook, its pages filled with scattered ideas, arrows, and fragments of plans that seemed important only moments ago.",
    "Outside, traffic moved in a steady rhythm, distant enough to be calming rather than distracting.",
  ];
  const words = paragraph.join(" ").split(" ");
  const chunks = words.map((word, index) => `${index === 0 ? "" : " "}${word}`);

  return {
    ...fixture,
    description:
      "Short active stream for pinned-bottom jitter regression proof.",
    sessions: [
      {
        ...session,
        streamingMessageId: assistantId,
        messages: session.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: [
                  {
                    type: "text" as const,
                    text: "Sure -- here's a medium-length paragraph for testing.",
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
    operations: [
      {
        kind: "restore" as const,
        atMs: 0,
        sessionId: session.sessionId,
        scrollPosition: "tail" as const,
      },
      {
        kind: "startStreamingText" as const,
        atMs: 100,
        sessionId: session.sessionId,
        messageId: assistantId,
        chunks,
        chunkIntervalMs: 60,
        streamId,
      },
      {
        kind: "waitForStreamingText" as const,
        atMs: 2_000,
        streamId,
      },
    ],
  };
}

async function waitForActiveStreamScrollRange(page: Page, messageId: string) {
  const waitForCondition = () =>
    page.waitForFunction(
      (targetMessageId) => {
        const harnessWindow = window as TranscriptHarnessWindow;
        const diagnostics =
          harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.() as
            | Record<string, unknown>
            | undefined;
        const scroller = document.querySelector(
          '[data-testid="message-timeline-scroll"]',
        );
        if (!(scroller instanceof HTMLElement)) {
          return false;
        }

        const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
        const escapedMessageId = CSS.escape(targetMessageId);
        const visibleActiveRows = Array.from(
          scroller.querySelectorAll<HTMLElement>(
            `[data-virtual-row-message-id="${escapedMessageId}"]`,
          ),
        ).filter((row) => {
          const rowRect = row.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          return (
            rowRect.bottom > scrollerRect.top + 1 &&
            rowRect.top < scrollerRect.bottom - 1
          );
        });

        return (
          Number(diagnostics?.activeStreamingOperations ?? 0) > 0 &&
          Number(diagnostics?.streamingChunkApplyCount ?? 0) >= 8 &&
          maxScrollTop > 480 &&
          visibleActiveRows.length > 0
        );
      },
      messageId,
      { timeout: 5_000 },
    );

  await waitForCondition();
  await settleFrames(page, 2);
  await waitForCondition();
}

async function waitForStoppedStreamingScrollRange(
  page: Page,
  messageId: string,
) {
  const waitForCondition = () =>
    page.waitForFunction(
      async (targetMessageId) => {
        const harnessWindow = window as TranscriptHarnessWindow;
        const diagnostics =
          (await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.()) as
            | Record<string, unknown>
            | undefined;
        const list = document.querySelector(
          '[data-testid="virtual-message-timeline-list"]',
        );
        const scroller = document.querySelector(
          '[data-testid="message-timeline-scroll"]',
        );
        if (
          !(list instanceof HTMLElement) ||
          !(scroller instanceof HTMLElement)
        ) {
          return false;
        }

        const escapedMessageId = CSS.escape(targetMessageId);
        const activeRows = scroller.querySelectorAll(
          `[data-virtual-row-message-id="${escapedMessageId}"]`,
        );
        const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;

        return (
          Number(diagnostics?.activeStreamingOperations ?? 0) === 0 &&
          Number(list.dataset.virtualStreamingTailRows ?? 0) === 0 &&
          Number(list.dataset.virtualCompletedStreamingFragmentRows ?? 0) > 0 &&
          maxScrollTop > 480 &&
          activeRows.length > 0
        );
      },
      messageId,
      { timeout: 5_000 },
    );

  await waitForCondition();
  await settleFrames(page, 2);
  await waitForCondition();
}

async function scrollToActiveResponseTop(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector(
      '[data-testid="message-timeline-scroll"]',
    );
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("message timeline scroller was not mounted");
    }

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settleFrames(page, 2);
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function collectMessageTopSamplesDuringStreaming(
  page: Page,
  messageId: string,
  options: { durationMs: number; sampleIntervalMs: number },
) {
  return page.evaluate(
    async ({ targetMessageId, durationMs, sampleIntervalMs }) => {
      const samples: {
        elapsedMs: number;
        topPx: number | null;
        distanceFromBottom: number;
        streamingChunkApplyCount: number;
        activeStreamingOperations: number;
      }[] = [];
      const startedAt = performance.now();
      const escapedMessageId = CSS.escape(targetMessageId);

      while (performance.now() - startedAt <= durationMs) {
        const scroller = document.querySelector(
          '[data-testid="message-timeline-scroll"]',
        );
        const target = document.querySelector(
          `[data-transcript-message-id="${escapedMessageId}"]`,
        );
        const harnessWindow = window as TranscriptHarnessWindow;
        const diagnostics =
          (await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.()) ??
          {};

        if (scroller instanceof HTMLElement) {
          const scrollerRect = scroller.getBoundingClientRect();
          const targetRect =
            target instanceof HTMLElement
              ? target.getBoundingClientRect()
              : null;

          samples.push({
            elapsedMs: performance.now() - startedAt,
            topPx: targetRect ? targetRect.top - scrollerRect.top : null,
            distanceFromBottom:
              scroller.scrollHeight -
              scroller.scrollTop -
              scroller.clientHeight,
            streamingChunkApplyCount: Number(
              diagnostics.streamingChunkApplyCount ?? 0,
            ),
            activeStreamingOperations: Number(
              diagnostics.activeStreamingOperations ?? 0,
            ),
          });
        }

        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, sampleIntervalMs),
        );
      }

      return samples;
    },
    {
      targetMessageId: messageId,
      durationMs: options.durationMs,
      sampleIntervalMs: options.sampleIntervalMs,
    },
  );
}

test.describe("transcript streaming scrollback proof", () => {
  test("virtual renderer keeps the bottom pinned while a short response streams", async ({
    page,
  }) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "streaming pinned-bottom proof requires the real renderer bridge",
    );

    const fixture = buildPinnedBottomStreamingFixture();
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );

    if (!startOperation) {
      throw new Error(
        "streaming pinned-bottom fixture is missing proof inputs",
      );
    }

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });
    await applyHarnessOperation(page, fixture.operations[0]);
    await applyHarnessOperation(page, startOperation);

    const evidence = await collectTranscriptStreamingScrollbackEvidence(page, {
      durationMs: 1_200,
      sampleIntervalMs: 50,
    });
    const activeSamples = evidence.samples.filter(
      (sample) =>
        readNumber(sample.diagnostics, "activeStreamingOperations") > 0 &&
        readNumber(sample.diagnostics, "streamingChunkApplyCount") > 1,
    );

    expect(
      activeSamples.length,
      "proof must include repeated samples while streaming is active",
    ).toBeGreaterThanOrEqual(8);

    for (const sample of activeSamples) {
      expect(
        sample.scroll.distanceFromBottom,
        "pinned-bottom streaming should not visibly lag behind the moving bottom",
      ).toBeLessThanOrEqual(8);
      expect(sample.scroll.nearBottom).toBe(true);
    }
  });

  test("virtual renderer does not bounce stable rows while a short response streams at bottom", async ({
    page,
  }) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "streaming row stability proof requires the real renderer bridge",
    );

    const fixture = buildPinnedBottomStreamingFixture();
    const targetMessageId = "spacing-tail-user";
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );

    if (!startOperation) {
      throw new Error(
        "streaming row stability fixture is missing proof inputs",
      );
    }

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });
    await applyHarnessOperation(page, fixture.operations[0]);
    await applyHarnessOperation(page, startOperation);

    const samples = await collectMessageTopSamplesDuringStreaming(
      page,
      targetMessageId,
      {
        durationMs: 1_200,
        sampleIntervalMs: 16,
      },
    );
    const activeSamples = samples.filter(
      (sample) =>
        sample.activeStreamingOperations > 0 &&
        sample.streamingChunkApplyCount > 1 &&
        sample.topPx != null,
    );
    const downwardJumps = activeSamples
      .slice(1)
      .map((sample, index) => ({
        previous: activeSamples[index] as (typeof activeSamples)[number],
        current: sample,
        deltaPx: (sample.topPx ?? 0) - (activeSamples[index]?.topPx ?? 0),
      }))
      .filter((sample) => sample.deltaPx > 3);

    expect(
      activeSamples.length,
      "proof must include repeated mounted-row samples while streaming is active",
    ).toBeGreaterThanOrEqual(24);
    expect(
      downwardJumps,
      "stable rows above a pinned streaming answer should not bounce downward",
    ).toEqual([]);
  });

  test("virtual renderer allows wheel scroll from the top of an active over-tall response", async ({
    page,
  }) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "streaming scrollback proof requires the real renderer bridge",
    );

    const fixture = buildStreamingStartsShortFixture();
    const session = fixture.sessions[0];
    const assistantId = session.streamingMessageId;
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );

    if (!assistantId || !startOperation) {
      throw new Error("streaming scrollback fixture is missing proof inputs");
    }

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });
    await applyHarnessOperation(page, fixture.operations[0]);
    await applyHarnessOperation(page, startOperation);
    await waitForActiveStreamScrollRange(page, assistantId);

    const pinnedSnapshot = await collectTranscriptScrollSnapshot(page);
    const firstActiveRow = pinnedSnapshot.visibleRows.find(
      (row) => row.messageId === assistantId,
    );
    expect(
      firstActiveRow?.topPx,
      "untouched over-tall active response should pin near the top before the user scrolls",
    ).toBeLessThanOrEqual(64);
    expect(
      firstActiveRow?.topPx,
      "active response top pin should keep the row inside the viewport",
    ).toBeGreaterThanOrEqual(-2);

    const wheelScroll = await wheelInsideActiveResponse(page, 900);
    expect(
      wheelScroll.before.scrollHeight - wheelScroll.before.clientHeight,
      "active response should have a real scroll range before the wheel proof",
    ).toBeGreaterThan(480);
    expect(
      wheelScroll.after.scrollTop,
      "user wheel input should move the viewport while the over-tall response is still streaming",
    ).toBeGreaterThan(wheelScroll.before.scrollTop + 120);
    expect(
      readNumber(
        await page.evaluate(async () => {
          const harnessWindow = window as TranscriptHarnessWindow;
          return (
            (await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.()) ??
            {}
          );
        }),
        "activeStreamingOperations",
      ),
      "streaming must still be active after the user scroll proof",
    ).toBeGreaterThan(0);
  });

  test("virtual renderer has no blank viewport while long markdown is still streaming and user scrolls back", async ({
    page,
  }) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "streaming scrollback proof requires the real renderer bridge",
    );

    const fixture = buildTranscriptFixture(
      "streaming-scrollback-long-markdown",
    );
    const session = fixture.sessions[0];
    const assistantId = session.streamingMessageId;
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );
    const waitOperation = fixture.operations.find(
      (operation) => operation.kind === "waitForStreamingText",
    );

    if (!assistantId || !startOperation || !waitOperation) {
      throw new Error("streaming scrollback fixture is missing proof inputs");
    }

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });
    await applyHarnessOperation(page, fixture.operations[0]);
    await applyHarnessOperation(page, startOperation);
    await waitForActiveStreamScrollRange(page, assistantId);
    await scrollBackInsideActiveResponse(page, assistantId);

    const wheelScroll = await wheelInsideActiveResponse(page, 900);
    expect(
      wheelScroll.after.scrollTop,
      "user wheel input should move the viewport while the long response is still streaming",
    ).toBeGreaterThan(wheelScroll.before.scrollTop + 120);
    expect(
      readNumber(
        await page.evaluate(async () => {
          const harnessWindow = window as TranscriptHarnessWindow;
          return (
            (await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.()) ??
            {}
          );
        }),
        "activeStreamingOperations",
      ),
      "streaming must still be active after the user scroll proof",
    ).toBeGreaterThan(0);

    const evidence = await collectTranscriptStreamingScrollbackEvidence(page, {
      durationMs: 1_200,
      sampleIntervalMs: 80,
    });
    const activeSamples = evidence.samples.filter(
      (sample) =>
        readNumber(sample.diagnostics, "activeStreamingOperations") > 0,
    );

    expect(
      activeSamples.length,
      "proof must include repeated samples while streaming is still active",
    ).toBeGreaterThanOrEqual(8);

    for (const sample of activeSamples) {
      expect(sample.viewport.blankViewportPixels).toBeLessThanOrEqual(
        DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.blankViewportPixels,
      );
      expect(sample.viewport.visibleRowCount).toBeGreaterThan(0);
      expect(Number.isFinite(sample.scroll.scrollTop)).toBe(true);
      expect(Number.isFinite(sample.scroll.scrollHeight)).toBe(true);
      expect(Number.isFinite(sample.scroll.clientHeight)).toBe(true);
      expect(sample.dom.streamingTailRowCount).toBe(0);
      expect(sample.dom.completedStreamingFragmentRowCount).toBe(0);
      expect(sample.dom.virtualUnmountingEnabled).toBe(true);
      expect(sample.dom.fallbackReasons).toEqual([]);
      expect(sample.dom.mountedRows).toBeLessThanOrEqual(
        DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.mountedRows,
      );
    }

    expect(
      activeSamples.some((sample) => !sample.scroll.nearBottom),
      "scrollback should detach from latest while the stream is active",
    ).toBe(true);
    expect(
      activeSamples.some((sample) =>
        sample.scroll.visibleRows.some((row) => row.messageId === assistantId),
      ),
      "active samples should include visible rows from the streaming response",
    ).toBe(true);
    const visibleStreamingRenderRevisions = activeSamples.flatMap((sample) =>
      sample.scroll.visibleRows
        .filter((row) => row.messageId === assistantId)
        .flatMap((row) => (row.renderRevision ? [row.renderRevision] : [])),
    );
    expect(
      new Set(visibleStreamingRenderRevisions).size,
      "the visible active streaming row should keep receiving rendered text updates while detached",
    ).toBeGreaterThan(1);

    const firstChunkCount = readNumber(
      activeSamples[0]?.diagnostics ?? {},
      "streamingChunkApplyCount",
    );
    const lastChunkCount = readNumber(
      activeSamples[activeSamples.length - 1]?.diagnostics ?? {},
      "streamingChunkApplyCount",
    );
    expect(
      lastChunkCount,
      "chunks should continue applying during the active sample window",
    ).toBeGreaterThan(firstChunkCount);

    await applyHarnessOperation(page, waitOperation);
    const settledViewport = await collectTranscriptViewportEvidence(page);
    expect(settledViewport.blankViewportPixels).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.blankViewportPixels,
    );
  });

  test("virtual renderer keeps a stopped long response scrollable after session remount", async ({
    page,
  }) => {
    test.skip(
      !rendererUrl.includes("real-renderer-bridge"),
      "stopped streaming remount proof requires the real renderer bridge",
    );

    const fixture = buildStreamingCancelRemountFixture();
    const session = fixture.sessions[0];
    const assistantId = session.streamingMessageId;
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );
    const otherSession = fixture.sessions[1];

    if (!assistantId || !startOperation || !otherSession) {
      throw new Error("streaming cancel fixture is missing proof inputs");
    }

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });
    await applyHarnessOperation(page, fixture.operations[0]);
    await applyHarnessOperation(page, startOperation);
    await waitForActiveStreamScrollRange(page, assistantId);

    await applyHarnessOperation(page, {
      kind: "stopStreamingText",
      atMs: 0,
      sessionId: session.sessionId,
      messageId: assistantId,
      streamId: startOperation.streamId,
    });
    await waitForStoppedStreamingScrollRange(page, assistantId);

    await applyHarnessOperation(page, {
      kind: "switchSession",
      atMs: 0,
      fromSessionId: session.sessionId,
      toSessionId: otherSession.sessionId,
      pendingAsyncWork: ["streaming-cancel-remount"],
    });
    await applyHarnessOperation(page, {
      kind: "switchSession",
      atMs: 0,
      fromSessionId: otherSession.sessionId,
      toSessionId: session.sessionId,
      pendingAsyncWork: [],
    });
    await waitForStoppedStreamingScrollRange(page, assistantId);
    await scrollToActiveResponseTop(page);

    const wheelScroll = await wheelInsideActiveResponse(page, 900);
    expect(
      wheelScroll.after.scrollTop,
      "user wheel input should move the viewport after a stopped long response remounts",
    ).toBeGreaterThan(wheelScroll.before.scrollTop + 120);

    const dom = await collectTranscriptVirtualTimelineDomCounters(page);
    const viewport = await collectTranscriptViewportEvidence(page);

    expect(dom.streamingTailRowCount).toBe(0);
    expect(dom.completedStreamingFragmentRowCount).toBeGreaterThan(0);
    expect(dom.virtualUnmountingEnabled).toBe(true);
    expect(dom.fallbackReasons).toEqual([]);
    expect(dom.mountedRows).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.mountedRows,
    );
    expect(viewport.blankViewportPixels).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.blankViewportPixels,
    );
  });
});
