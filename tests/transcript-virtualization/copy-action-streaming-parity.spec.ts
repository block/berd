import { expect, test, type Page } from "@playwright/test";
import {
  TRANSCRIPT_FIXTURE_BASE_TIME,
  TRANSCRIPT_FIXTURE_VERSION,
  type TranscriptFixture,
  type TranscriptHarnessOperation,
  type TranscriptRendererMode,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import type { Message } from "../../src/shared/types/messages";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import { loadTranscriptRenderer } from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;
const requiresRealRenderer = rendererUrl !== LOCAL_TRANSCRIPT_RENDERER_URL;

const sessionId = "copy-action-streaming-parity-session";
const assistantMessageId = "copy-action-streaming-assistant";
const assistantText =
  "Streaming answer has enough text for the mounted copy action.";
const firstStreamingChunk = "alpha visible before completion";
const secondStreamingChunk = " omega visible after completion";
const fullIncrementalStreamingText = `${firstStreamingChunk}${secondStreamingChunk}`;

interface ActionVisualState {
  mounted: boolean;
  buttonMounted: boolean;
  buttonLeft: number | null;
  buttonRight: number | null;
  copyConfirmed: string | null;
  display: string | null;
  focusedWithin: boolean;
  height: number;
  hovered: boolean;
  opacity: number | null;
  pointerEvents: string | null;
  visibility: string | null;
  virtualRowLeft: number | null;
  virtualRowRight: number | null;
  width: number;
}

interface IncrementalStreamingPaintState {
  activeStreamingOperations: number;
  rowVisible: boolean;
  text: string;
  visiblePartialText: boolean;
  visiblePartialTextHeight: number;
  visiblePartialTextWidth: number;
}

declare global {
  interface Window {
    __COPY_ACTION_STREAMING_PARITY_COPIED_TEXT__?: string;
    __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: {
      applyOperation?: (
        operation: TranscriptHarnessOperation,
      ) => void | Promise<void>;
      collectDiagnostics?: () =>
        | Record<string, unknown>
        | Promise<Record<string, unknown>>;
    };
  }
}

function buildStreamingCopyFixture(): TranscriptFixture {
  const messages: Message[] = [
    {
      id: "copy-action-streaming-user",
      role: "user",
      created: TRANSCRIPT_FIXTURE_BASE_TIME,
      content: [
        {
          type: "text",
          text: "Keep copy affordances hidden while the answer streams.",
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
    {
      id: assistantMessageId,
      role: "assistant",
      created: TRANSCRIPT_FIXTURE_BASE_TIME + 60_000,
      content: [{ type: "text", text: assistantText }],
      metadata: {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
      },
    },
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "copy-action-streaming-parity",
    description:
      "Small active streaming transcript for copy action visual reveal parity.",
    activeSessionId: sessionId,
    sessions: [
      {
        sessionId,
        title: "Copy action streaming parity",
        messages,
        streamingMessageId: assistantMessageId,
      },
    ],
    operations: [],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 2,
      maxInitialMountedRows: 8,
      maxProtectedRows: 4,
      dynamicRowCount: 1,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildIncrementalStreamingFixture(): TranscriptFixture {
  const messages: Message[] = [
    {
      id: "incremental-streaming-user",
      role: "user",
      created: TRANSCRIPT_FIXTURE_BASE_TIME,
      content: [
        {
          type: "text",
          text: "Stream the answer incrementally.",
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
    {
      id: assistantMessageId,
      role: "assistant",
      created: TRANSCRIPT_FIXTURE_BASE_TIME + 60_000,
      content: [{ type: "text", text: "" }],
      metadata: {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
      },
    },
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "copy-action-streaming-parity",
    description:
      "Active streaming transcript that must paint text before completion.",
    activeSessionId: sessionId,
    sessions: [
      {
        sessionId,
        title: "Incremental streaming paint",
        messages,
        streamingMessageId: assistantMessageId,
      },
    ],
    operations: [],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 2,
      maxInitialMountedRows: 8,
      maxProtectedRows: 4,
      dynamicRowCount: 1,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

async function installClipboardProbe(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.__COPY_ACTION_STREAMING_PARITY_COPIED_TEXT__ = text;
        },
      },
    });
  });
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

async function collectActionVisualState(
  page: Page,
  messageText: string,
): Promise<ActionVisualState> {
  return page.evaluate((targetMessageText) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="assistant-message"]'),
    ).find((element) => element.textContent?.includes(targetMessageText));
    const actions = row?.querySelector<HTMLElement>(
      '[data-role="message-actions"]',
    );
    const button = actions?.querySelector("button") ?? null;
    const virtualRow = actions?.closest<HTMLElement>("[data-virtual-row-id]");
    if (!actions) {
      return {
        mounted: false,
        buttonMounted: Boolean(button),
        buttonLeft: null,
        buttonRight: null,
        copyConfirmed: null,
        display: null,
        focusedWithin: false,
        height: 0,
        hovered: false,
        opacity: null,
        pointerEvents: null,
        visibility: null,
        virtualRowLeft: null,
        virtualRowRight: null,
        width: 0,
      };
    }

    const style = getComputedStyle(actions);
    const rect = actions.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect() ?? null;
    const virtualRowRect = virtualRow?.getBoundingClientRect() ?? null;
    return {
      mounted: true,
      buttonMounted: Boolean(button),
      buttonLeft: buttonRect?.left ?? null,
      buttonRight: buttonRect?.right ?? null,
      copyConfirmed: actions.getAttribute("data-copy-confirmed"),
      display: style.display,
      focusedWithin: actions.matches(":focus-within"),
      height: rect.height,
      hovered: actions.matches(":hover") || Boolean(row?.matches(":hover")),
      opacity: Number.parseFloat(style.opacity),
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      virtualRowLeft: virtualRowRect?.left ?? null,
      virtualRowRight: virtualRowRect?.right ?? null,
      width: rect.width,
    };
  }, messageText);
}

async function collectIncrementalStreamingPaintState(
  page: Page,
): Promise<IncrementalStreamingPaintState> {
  return page.evaluate(
    async ({ messageId, visibleChunk }) => {
      const escapedMessageId = CSS.escape(messageId);
      const row =
        document.querySelector<HTMLElement>(
          [
            `[data-transcript-message-id="${escapedMessageId}"]`,
            `[data-virtual-row-message-id="${escapedMessageId}"]`,
            `[data-virtual-row-id$="message:${escapedMessageId}"]`,
            `[data-virtual-row-id$="${escapedMessageId}"]`,
          ].join(","),
        ) ??
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-role="assistant-message"]',
          ),
        ).at(-1) ??
        null;
      const diagnostics =
        await window.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.();
      const rowRect = row?.getBoundingClientRect() ?? null;
      const rowStyle = row ? getComputedStyle(row) : null;
      const walker =
        row != null
          ? document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
          : null;
      let visiblePartialText = false;
      let visiblePartialTextHeight = 0;
      let visiblePartialTextWidth = 0;

      while (walker != null) {
        const node = walker.nextNode();
        if (node == null) {
          break;
        }
        const index = node.textContent?.indexOf(visibleChunk) ?? -1;
        if (index < 0) {
          continue;
        }

        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + visibleChunk.length);
        for (const rect of Array.from(range.getClientRects())) {
          const intersectsViewport =
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight;
          if (intersectsViewport && rect.width > 0 && rect.height > 0) {
            visiblePartialText = true;
            visiblePartialTextHeight = Math.max(
              visiblePartialTextHeight,
              rect.height,
            );
            visiblePartialTextWidth = Math.max(
              visiblePartialTextWidth,
              rect.width,
            );
          }
        }
        range.detach();

        if (visiblePartialText) {
          break;
        }
      }

      return {
        activeStreamingOperations: Number(
          diagnostics?.activeStreamingOperations ?? 0,
        ),
        rowVisible:
          rowRect != null &&
          rowStyle != null &&
          rowStyle.display !== "none" &&
          rowStyle.visibility !== "hidden" &&
          Number.parseFloat(rowStyle.opacity) > 0 &&
          rowRect.width > 0 &&
          rowRect.height > 0,
        text: row?.textContent ?? "",
        visiblePartialText,
        visiblePartialTextHeight,
        visiblePartialTextWidth,
      };
    },
    { messageId: assistantMessageId, visibleChunk: firstStreamingChunk },
  );
}

async function expectActionHidden(page: Page, messageText: string) {
  await expect
    .poll(async () => {
      const state = await collectActionVisualState(page, messageText);
      return (
        state.mounted &&
        state.buttonMounted &&
        state.copyConfirmed === "false" &&
        state.pointerEvents === "none" &&
        state.display !== "none" &&
        state.visibility === "visible" &&
        state.width > 0 &&
        state.height > 0 &&
        state.opacity != null &&
        state.opacity <= 0.01
      );
    })
    .toBe(true);

  const state = await collectActionVisualState(page, messageText);
  expect(state.display).not.toBe("none");
  expect(state.visibility).toBe("visible");
  expect(state.width).toBeGreaterThan(0);
  expect(state.height).toBeGreaterThan(0);
  expect(state.opacity).not.toBeNull();
  expect(state.opacity ?? 1).toBeLessThanOrEqual(0.01);
}

async function expectActionVisible(
  page: Page,
  messageText: string,
  expectedCopyConfirmed?: "true" | "false",
) {
  await expect
    .poll(async () => {
      const state = await collectActionVisualState(page, messageText);
      return (
        state.mounted &&
        state.buttonMounted &&
        state.pointerEvents === "auto" &&
        (!expectedCopyConfirmed ||
          state.copyConfirmed === expectedCopyConfirmed) &&
        state.opacity != null &&
        state.opacity >= 0.99
      );
    })
    .toBe(true);

  const state = await collectActionVisualState(page, messageText);
  expect(state.opacity).not.toBeNull();
  expect(state.opacity ?? 0).toBeGreaterThanOrEqual(0.99);
  expect(state.buttonLeft).not.toBeNull();
  expect(state.buttonRight).not.toBeNull();
  if (state.virtualRowLeft != null && state.virtualRowRight != null) {
    expect(state.buttonLeft ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(
      state.virtualRowLeft - 0.5,
    );
    expect(state.buttonRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      state.virtualRowRight + 0.5,
    );
  }
}

async function moveAwayFromMessage(page: Page) {
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) - 4, 4);
  await settleFrames(page, 2);
}

async function focusCopyAction(page: Page, messageText: string) {
  await page.evaluate((targetMessageText) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="assistant-message"]'),
    ).find((element) => element.textContent?.includes(targetMessageText));
    const copyButton = row?.querySelector<HTMLButtonElement>(
      '[data-role="message-actions"] button',
    );
    copyButton?.focus();
  }, messageText);
  await settleFrames(page, 2);
}

async function blurActiveElement(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await settleFrames(page, 2);
}

async function validateMode(page: Page, rendererMode: TranscriptRendererMode) {
  await loadTranscriptRenderer(page, {
    rendererUrl,
    rendererMode,
    fixture: buildStreamingCopyFixture(),
  });
  await settleFrames(page, 4);
  await moveAwayFromMessage(page);

  const row = page
    .locator('[data-role="assistant-message"]')
    .filter({ hasText: assistantText })
    .first();
  await expect(row).toBeVisible();
  await expect(
    row.locator('[data-role="message-actions"] button').first(),
  ).toHaveCount(1);

  await expectActionHidden(page, assistantText);

  await row.hover();
  await expectActionVisible(page, assistantText, "false");

  await moveAwayFromMessage(page);
  await expectActionHidden(page, assistantText);

  await focusCopyAction(page, assistantText);
  await expectActionVisible(page, assistantText, "false");

  await blurActiveElement(page);
  await expectActionHidden(page, assistantText);

  await row.hover();
  await expectActionVisible(page, assistantText, "false");
  await row.getByRole("button", { name: "Copy" }).click();
  await expectActionVisible(page, assistantText, "true");
  await expect
    .poll(() =>
      page.evaluate(() => window.__COPY_ACTION_STREAMING_PARITY_COPIED_TEXT__),
    )
    .toBe(assistantText);

  await blurActiveElement(page);
  await moveAwayFromMessage(page);
  await expectActionVisible(page, assistantText, "true");

  await page.waitForTimeout(2_100);
  await expectActionHidden(page, assistantText);
}

async function applyHarnessOperation(
  page: Page,
  operation: TranscriptHarnessOperation,
) {
  await page.evaluate(async (nextOperation) => {
    const harness = window.__TRANSCRIPT_VIRTUALIZATION_HARNESS__;
    if (!harness?.applyOperation) {
      throw new Error("Transcript renderer harness is unavailable");
    }
    await harness.applyOperation(nextOperation);
  }, operation);
}

async function validateIncrementalStreamingPaint(
  page: Page,
  rendererMode: TranscriptRendererMode,
) {
  await loadTranscriptRenderer(page, {
    rendererUrl,
    rendererMode,
    fixture: buildIncrementalStreamingFixture(),
  });
  await settleFrames(page, 4);

  await applyHarnessOperation(page, {
    kind: "startStreamingText",
    atMs: 0,
    sessionId,
    messageId: assistantMessageId,
    chunks: [firstStreamingChunk, secondStreamingChunk],
    chunkIntervalMs: 1_000,
    streamId: "incremental-paint",
  });

  await expect
    .poll(collectIncrementalStreamingPaintState.bind(null, page), {
      intervals: [50, 50, 100, 100, 250],
      message: `${rendererMode} should visibly paint partial text while streaming remains active`,
      timeout: 2_000,
    })
    .toMatchObject({
      activeStreamingOperations: 1,
      rowVisible: true,
      text: expect.stringContaining(firstStreamingChunk),
      visiblePartialText: true,
    });
  const partialState = await collectIncrementalStreamingPaintState(page);
  expect(partialState.text).not.toContain(secondStreamingChunk);
  expect(partialState.visiblePartialTextWidth).toBeGreaterThan(0);
  expect(partialState.visiblePartialTextHeight).toBeGreaterThan(0);
  await expect(page.getByText(fullIncrementalStreamingText)).toHaveCount(0);

  await applyHarnessOperation(page, {
    kind: "waitForStreamingText",
    atMs: 0,
    streamId: "incremental-paint",
  });
  await expect(page.getByText(fullIncrementalStreamingText)).toBeVisible();
}

test.describe("copy action active-streaming visual reveal parity", () => {
  test("legacy and virtual renderers paint active streaming text incrementally", async ({
    page,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "incremental streaming paint requires the production React transcript renderer",
    );

    for (const rendererMode of ["legacy", "virtual"] as const) {
      await test.step(rendererMode, async () => {
        await validateIncrementalStreamingPaint(page, rendererMode);
      });
    }
  });

  test("legacy and virtual renderers hide mounted copy actions until reveal conditions", async ({
    page,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "copy action visual parity requires the production React transcript renderer",
    );

    await installClipboardProbe(page);

    for (const rendererMode of ["legacy", "virtual"] as const) {
      await test.step(rendererMode, async () => {
        await validateMode(page, rendererMode);
      });
    }
  });
});
