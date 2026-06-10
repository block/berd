import { expect, test, type Page } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptFixture,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import { loadTranscriptRenderer } from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;

// The real renderer mounts the production VirtualMessageTimeline, which is
// where resize anchoring lives. The synthetic local bridge does not model
// width-driven rewrap, so these assertions only run against the real bridge.
const isRealRenderer = rendererUrl !== LOCAL_TRANSCRIPT_RENDERER_URL;

interface FrameSample {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  firstRowId: string | null;
  firstRowTop: number | null;
  detachedButton: boolean;
}

declare global {
  interface Window {
    __RESIZE_PROBE_SAMPLES__?: FrameSample[];
    __RESIZE_PROBE_SAMPLING__?: boolean;
  }
}

function buildRewrapFixture(messageCount: number): TranscriptFixture {
  const fixture = buildTranscriptFixture("long-10k", { messageCount });
  const session = fixture.sessions[0];
  if (!session) {
    throw new Error("fixture session missing");
  }
  const longParagraph = (index: number) => {
    const sentences = 3 + (index % 9);
    return Array.from(
      { length: sentences },
      (_, sentence) =>
        `Sentence ${sentence} of message ${index} stretches across the transcript column so that narrowing the viewport forces every paragraph to rewrap onto more lines and grow taller in a width-dependent way.`,
    ).join(" ");
  };
  for (const [index, message] of session.messages.entries()) {
    if (message.role !== "assistant") {
      continue;
    }
    message.content = [
      {
        type: "text",
        text:
          `## Response ${index}\n\n${longParagraph(index)}\n\n` +
          `- bullet one with a fairly long descriptive clause about layout behavior under resize\n` +
          `- bullet two with another long clause that wraps at narrow widths\n\n${longParagraph(index + 1)}`,
      },
    ];
  }
  return fixture;
}

async function installFrameSampler(page: Page) {
  await page.evaluate(() => {
    window.__RESIZE_PROBE_SAMPLES__ = [];
    window.__RESIZE_PROBE_SAMPLING__ = true;
    const sample = () => {
      if (!window.__RESIZE_PROBE_SAMPLING__) {
        return;
      }
      const scroller = document.querySelector(
        '[data-testid="message-timeline-scroll"]',
      );
      if (scroller instanceof HTMLElement) {
        const rect = scroller.getBoundingClientRect();
        const rows = Array.from(
          scroller.querySelectorAll<HTMLElement>(
            '[data-testid^="virtual-transcript-row-"]',
          ),
        )
          .map((element) => ({
            id: element.getAttribute("data-virtual-row-id"),
            anchorPriority: element.getAttribute(
              "data-virtual-row-anchor-priority",
            ),
            rect: element.getBoundingClientRect(),
          }))
          .filter(
            (row) =>
              row.rect.bottom > rect.top + 1 && row.rect.top < rect.bottom - 1,
          )
          .sort((left, right) => left.rect.top - right.rect.top);
        const first =
          rows.find((row) => row.anchorPriority !== "none") ?? rows[0];
        const detachedButton = Boolean(
          Array.from(document.querySelectorAll("button")).find((button) =>
            /jump to latest/i.test(button.textContent ?? ""),
          ),
        );
        window.__RESIZE_PROBE_SAMPLES__?.push({
          t: performance.now(),
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          distanceFromBottom:
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          firstRowId: first?.id ?? null,
          firstRowTop: first ? first.rect.top - rect.top : null,
          detachedButton,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopAndCollectSamples(page: Page): Promise<FrameSample[]> {
  return page.evaluate(() => {
    window.__RESIZE_PROBE_SAMPLING__ = false;
    return window.__RESIZE_PROBE_SAMPLES__ ?? [];
  });
}

async function animateViewportWidth(page: Page, from: number, to: number) {
  const step = from > to ? -20 : 20;
  for (let width = from; step < 0 ? width >= to : width <= to; width += step) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(16);
  }
}

test.describe("transcript resize anchoring", () => {
  test.skip(
    !isRealRenderer,
    "resize anchoring runs against the real renderer bridge",
  );

  test("keeps the bottom pinned through a continuous width resize", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1000, height: 800 });
    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture: buildRewrapFixture(140),
    });
    await page.waitForTimeout(1500);

    await installFrameSampler(page);
    await animateViewportWidth(page, 1000, 620);
    await page.waitForTimeout(400);
    await animateViewportWidth(page, 620, 1000);
    await page.waitForTimeout(700);
    const samples = await stopAndCollectSamples(page);

    expect(samples.length).toBeGreaterThan(50);
    // The bottom must stay anchored: never further than the auto-scroll
    // threshold from the bottom, and never flipping into the detached state.
    for (const sample of samples) {
      expect
        .soft(
          sample.distanceFromBottom,
          `distance from bottom at t=${sample.t.toFixed(0)}`,
        )
        .toBeLessThan(180);
      expect
        .soft(sample.detachedButton, `detached at t=${sample.t.toFixed(0)}`)
        .toBe(false);
    }
    const last = samples.at(-1);
    expect(last?.distanceFromBottom ?? Number.POSITIVE_INFINITY).toBeLessThan(
      2,
    );
  });

  test("keeps the first visible row pinned through a continuous width resize when scrolled back", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1000, height: 800 });
    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture: buildRewrapFixture(140),
    });
    await page.waitForTimeout(1500);

    // Wheel-scroll back like a real user (real user intent detaches).
    const scroller = page.getByTestId("message-timeline-scroll");
    await scroller.hover();
    for (let index = 0; index < 12; index += 1) {
      await page.mouse.wheel(0, -2500);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(900);

    await installFrameSampler(page);
    await page.waitForTimeout(120);
    const baseline = (await page.evaluate(
      () => window.__RESIZE_PROBE_SAMPLES__ ?? [],
    )) as FrameSample[];
    const anchorBaseline = baseline.at(-1);
    expect(anchorBaseline?.firstRowId).toBeTruthy();

    await animateViewportWidth(page, 1000, 620);
    await page.waitForTimeout(400);
    await animateViewportWidth(page, 620, 1000);
    await page.waitForTimeout(700);
    const samples = await stopAndCollectSamples(page);
    const resizeSamples = samples.filter(
      (sample) => sample.t > (anchorBaseline?.t ?? 0),
    );

    expect(resizeSamples.length).toBeGreaterThan(50);
    // The first visible anchorable row must stay the same row at the same
    // viewport offset for the entire resize; content after it reflows.
    let previous = anchorBaseline ?? null;
    for (const sample of resizeSamples) {
      expect
        .soft(sample.firstRowId, `first row at t=${sample.t.toFixed(0)}`)
        .toBe(anchorBaseline?.firstRowId);
      if (
        previous &&
        previous.firstRowId === sample.firstRowId &&
        previous.firstRowTop != null &&
        sample.firstRowTop != null
      ) {
        expect
          .soft(
            Math.abs(sample.firstRowTop - previous.firstRowTop),
            `first row offset shift at t=${sample.t.toFixed(0)}`,
          )
          .toBeLessThanOrEqual(4);
      }
      previous = sample;
    }
    // Still detached (resize must not silently re-attach to the bottom).
    expect(resizeSamples.at(-1)?.detachedButton).toBe(true);
  });
});
