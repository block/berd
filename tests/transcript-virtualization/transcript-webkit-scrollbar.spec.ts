import { expect, test, type Page } from "@playwright/test";
import { buildTranscriptFixture } from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import { loadTranscriptRenderer } from "./harness/rendererHarness";
import { analyzeWebkitScrollbarSamples } from "../../src/features/chat/transcript/testing/webkitScrollbarAttestation";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;
const isRealRenderer = rendererUrl !== LOCAL_TRANSCRIPT_RENDERER_URL;
const MATERIAL_BACKWARD_SCROLL_PX = 200;
const MIN_INTER_EVENT_GAP_VIEWPORTS = 3;
const HARNESS_SEED = "webkit-native-thumb-v1";
const candidateHead = process.env.TRANSCRIPT_WEBKIT_CANDIDATE_HEAD;
const harnessRevision = process.env.TRANSCRIPT_WEBKIT_HARNESS_REV;

interface ScrollbarSample {
  kind: "frame" | "scroll" | "mutation" | "app-write";
  time: number;
  scrollTop: number;
  scrollHeight: number;
  renderRange: string;
  mountedRows: number;
}

async function installRecorder(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="message-timeline-scroll"]',
    );
    const list = document.querySelector<HTMLElement>(
      '[data-testid="virtual-message-timeline-list"]',
    );
    if (!scroller || !list) {
      throw new Error("virtual transcript scroller/list was not mounted");
    }

    const samples: ScrollbarSample[] = [];
    let running = true;
    const record = (kind: ScrollbarSample["kind"]) => {
      samples.push({
        kind,
        time: performance.now(),
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        renderRange: `${list.dataset.virtualRenderStart}:${list.dataset.virtualRenderEnd}`,
        mountedRows: Number(list.dataset.virtualRangeMountedRows ?? 0),
      });
    };
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    if (!scrollTopDescriptor?.get || !scrollTopDescriptor.set) {
      throw new Error("Element.scrollTop descriptor is unavailable");
    }
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: scrollTopDescriptor.get.bind(scroller),
      set(value: number) {
        scrollTopDescriptor.set?.call(scroller, value);
        record("app-write");
      },
    });
    const frame = () => {
      if (!running) return;
      record("frame");
      requestAnimationFrame(frame);
    };
    const onScroll = () => record("scroll");
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "childList" &&
            (record.addedNodes.length > 0 || record.removedNodes.length > 0),
        )
      ) {
        record("mutation");
      }
    });
    observer.observe(list, { childList: true, subtree: true });
    scroller.addEventListener("scroll", onScroll);
    requestAnimationFrame(frame);
    window.__webkitScrollbarRecorder = {
      stop() {
        running = false;
        observer.disconnect();
        scroller.removeEventListener("scroll", onScroll);
        delete scroller.scrollTop;
        return samples;
      },
    };
  });
}

async function stopRecorder(page: Page): Promise<ScrollbarSample[]> {
  return page.evaluate(() => window.__webkitScrollbarRecorder?.stop() ?? []);
}

function tallCodeFence(index: number): string {
  return [
    `## Measured assistant response ${index}`,
    "",
    "```ts",
    ...Array.from(
      { length: 180 },
      (_, line) => `const measured_${index}_${line} = ${line};`,
    ),
    "```",
    "",
    "The virtual range must reconcile this measured code block during the drag.",
  ].join("\n");
}

function buildVariedLongFixture() {
  const fixture = buildTranscriptFixture("long-10k", { messageCount: 2711 });
  const messages = fixture.sessions[0]?.messages;
  if (!messages) throw new Error("long transcript fixture has no messages");
  for (let index = 31; index < messages.length; index += 40) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content[0]?.type === "text") {
      message.content[0].text = tallCodeFence(index);
    }
  }
  return fixture;
}

test.describe("WebKit native virtual-transcript scrollbar", () => {
  test.skip(
    !isRealRenderer,
    "requires the production VirtualMessageTimeline bridge",
  );

  test("does not reverse during a monotonic native scrollbar-thumb drag across range replacements", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    expect(candidateHead, "runner must attest the candidate git HEAD").toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(
      harnessRevision,
      "runner must attest the harness blob revision",
    ).toMatch(/^[0-9a-f]{40}$/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture: buildVariedLongFixture(),
    });
    await page.waitForTimeout(1_500);

    const scroller = page.getByTestId("message-timeline-scroll");
    await scroller.hover();
    // Setup only: detach from tail with browser-owned wheel input before
    // acquiring the native thumb. The recorder starts after this setup.
    for (let index = 0; index < 65; index += 1) {
      await page.mouse.wheel(0, -8_000);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(250);
    const box = await scroller.boundingBox();
    if (!box) throw new Error("transcript scroller has no bounding box");
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const metrics = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="message-timeline-scroll"]',
      );
      if (!element)
        throw new Error("virtual transcript scroller was not mounted");
      return {
        scrollTop: element.scrollTop,
        maxScrollTop: element.scrollHeight - element.clientHeight,
        clientHeight: element.clientHeight,
        scrollbarMode:
          element.offsetWidth > element.clientWidth ? "classic" : "overlay",
      };
    });
    test.info().annotations.push({
      type: "effective scrollbar mode",
      description: metrics.scrollbarMode,
    });

    // Native scrollbar chrome is outside DOM hit testing. Approximate the
    // thumb center from its current native range position, then make a few
    // rapid large moves without rAF/evaluate round trips between them.
    const gutterX = box.x + box.width - 2;
    const thumbHeight = 24;
    const startY =
      box.y +
      thumbHeight / 2 +
      (metrics.scrollTop / metrics.maxScrollTop) *
        (metrics.clientHeight - thumbHeight);
    const endY = box.y + box.height - 4;

    await installRecorder(page);
    await page.mouse.move(gutterX, startY);
    await page.mouse.down();
    for (const fraction of [0.2, 0.5, 0.8, 1]) {
      await page.mouse.move(gutterX, startY + (endY - startY) * fraction);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const samples = await stopRecorder(page);

    const firstSample = samples[0];
    const lastSample = samples.at(-1);
    if (!firstSample || !lastSample) {
      throw new Error("native thumb drag did not produce recorder samples");
    }

    const analysis = analyzeWebkitScrollbarSamples(
      samples,
      MATERIAL_BACKWARD_SCROLL_PX,
    );
    expect(
      analysis.distinctRanges,
      "drag must cross at least two virtual ranges",
    ).toBeGreaterThanOrEqual(3);
    console.log(
      JSON.stringify({ metrics, firstSample, lastSample, samples }, null, 2),
    );
    expect(
      lastSample.scrollTop - firstSample.scrollTop,
      "monotonic downward thumb movement must advance native scrollTop",
    ).toBeGreaterThan(MATERIAL_BACKWARD_SCROLL_PX);
    expect(
      samples.some((entry) => entry.mountedRows > 0),
      "drag must retain mounted transcript rows",
    ).toBe(true);

    expect(
      analysis.largestInterEventGap,
      `drag must outrun the mounted range by ${MIN_INTER_EVENT_GAP_VIEWPORTS} viewports (mode: ${metrics.scrollbarMode})`,
    ).toBeGreaterThanOrEqual(
      metrics.clientHeight * MIN_INTER_EVENT_GAP_VIEWPORTS,
    );

    const attestation = {
      schema: "berd-transcript-webkit-scrollbar/v1",
      candidateHead,
      harnessRevision,
      platform: process.platform,
      webkit: {
        playwright: process.env.TRANSCRIPT_WEBKIT_VERSION ?? "unknown",
        userAgent,
      },
      seed: HARNESS_SEED,
      qualification: {
        distinctRanges: analysis.distinctRanges,
        rangeTransitions: analysis.rangeTransitions,
        largestInterEventGap: analysis.largestInterEventGap,
        requiredGap: metrics.clientHeight * MIN_INTER_EVENT_GAP_VIEWPORTS,
      },
      observations: {
        mutations: analysis.mutations,
        appWrites: analysis.appWrites,
        firstScrollTop: firstSample.scrollTop,
        lastScrollTop: lastSample.scrollTop,
        firstScrollHeight: firstSample.scrollHeight,
        lastScrollHeight: lastSample.scrollHeight,
        materialReversals: analysis.materialReversals,
      },
      metrics,
      samples,
    };
    console.log(`WEBKIT_SCROLLBAR_ATTESTATION ${JSON.stringify(attestation)}`);
    await test.info().attach("webkit-scrollbar-attestation", {
      body: Buffer.from(JSON.stringify(attestation, null, 2)),
      contentType: "application/json",
    });
    expect(
      analysis.materialReversals,
      `native monotonic drag reversed scrollTop (mode: ${metrics.scrollbarMode}): ${JSON.stringify({ samples })}`,
    ).toBe(0);
  });
});
