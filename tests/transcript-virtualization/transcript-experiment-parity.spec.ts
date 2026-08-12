import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  TRANSCRIPT_FIXTURE_BASE_TIME,
  TRANSCRIPT_FIXTURE_VERSION,
  buildTranscriptFixture,
  type TranscriptFixture,
  type TranscriptHarnessOperation,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import type { Message } from "../../src/shared/types/messages";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import {
  collectTranscriptScrollSnapshot,
  loadTranscriptRenderer,
  type TranscriptScrollSnapshot,
} from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;
const requiresRealRenderer = rendererUrl !== LOCAL_TRANSCRIPT_RENDERER_URL;
const BOTTOM_DISTANCE_TOLERANCE_PX = 8;
const SCROLL_DELTA_TOLERANCE_PX = 8;
const COPY_SCROLL_DELTA_TOLERANCE_PX = 24;
const INCREMENTAL_STREAMING_SESSION_ID = "parity-incremental-streaming";
const INCREMENTAL_STREAMING_ASSISTANT_ID =
  "parity-incremental-streaming-assistant";

interface RendererPair {
  legacyPage: Page;
  virtualPage: Page;
}

interface ActionGeometry {
  actionBottomInsetPx: number;
  actionLeftInsetPx: number;
  actionRightInsetPx: number;
  actionTopPx: number;
  rowHeightPx: number;
}

interface ElementGeometry {
  heightPx: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
}

async function settleFrames(page: Page, count = 3) {
  await page.evaluate(async (frameCount) => {
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    for (let index = 0; index < frameCount; index += 1) {
      await waitForFrame();
    }
  }, count);
}

async function loadPair(
  context: BrowserContext,
  fixture: TranscriptFixture,
): Promise<RendererPair> {
  const legacyPage = await context.newPage();
  const virtualPage = await context.newPage();

  await loadTranscriptRenderer(legacyPage, {
    rendererUrl,
    rendererMode: "legacy",
    fixture,
  });
  await loadTranscriptRenderer(virtualPage, {
    rendererUrl,
    rendererMode: "virtual",
    fixture,
  });

  return { legacyPage, virtualPage };
}

async function withRendererPair(
  context: BrowserContext,
  fixture: TranscriptFixture,
  run: (pair: RendererPair) => Promise<void>,
) {
  const pair = await loadPair(context, fixture);
  try {
    await run(pair);
  } finally {
    await pair.legacyPage.close();
    await pair.virtualPage.close();
  }
}

async function collectPairScroll(pair: RendererPair) {
  const [legacy, virtual] = await Promise.all([
    collectTranscriptScrollSnapshot(pair.legacyPage),
    collectTranscriptScrollSnapshot(pair.virtualPage),
  ]);
  return { legacy, virtual };
}

async function applyOperation(
  page: Page,
  operation: TranscriptHarnessOperation,
) {
  await page.evaluate(async (nextOperation) => {
    const harnessWindow = window as Window & {
      __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: {
        applyOperation?: (
          operation: TranscriptHarnessOperation,
        ) => void | Promise<void>;
      };
    };
    await harnessWindow.__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.applyOperation?.(
      nextOperation,
    );
  }, operation);
  await settleFrames(page);
}

async function applyPairOperation(
  pair: RendererPair,
  operation: TranscriptHarnessOperation,
) {
  await applyOperation(pair.legacyPage, operation);
  await applyOperation(pair.virtualPage, operation);
}

async function applyPairOperationWithScrollSnapshots(
  pair: RendererPair,
  operation: TranscriptHarnessOperation,
) {
  const before = await collectPairScroll(pair);
  await applyPairOperation(pair, operation);
  const after = await collectPairScroll(pair);
  return { before, after };
}

function expectBottomParity(
  legacy: TranscriptScrollSnapshot,
  virtual: TranscriptScrollSnapshot,
) {
  expect(legacy.nearBottom, "legacy should land at latest").toBe(true);
  expect(virtual.nearBottom, "virtual should land at latest").toBe(true);
  expect(legacy.distanceFromBottom).toBeLessThanOrEqual(
    BOTTOM_DISTANCE_TOLERANCE_PX,
  );
  expect(virtual.distanceFromBottom).toBeLessThanOrEqual(
    legacy.distanceFromBottom + BOTTOM_DISTANCE_TOLERANCE_PX,
  );
}

function expectStableDetachedScroll(
  before: TranscriptScrollSnapshot,
  after: TranscriptScrollSnapshot,
  context: string,
  tolerancePx = SCROLL_DELTA_TOLERANCE_PX,
) {
  expect(before.nearBottom, `${context}: should start detached`).toBe(false);
  expect(after.nearBottom, `${context}: should remain detached`).toBe(false);
  expect(
    Math.abs(after.scrollTop - before.scrollTop),
    `${context}: scrollTop should remain stable`,
  ).toBeLessThanOrEqual(tolerancePx);
}

function expectDetachedScrollDeltaNoWorseThanLegacy(
  legacyBefore: TranscriptScrollSnapshot,
  legacyAfter: TranscriptScrollSnapshot,
  virtualBefore: TranscriptScrollSnapshot,
  virtualAfter: TranscriptScrollSnapshot,
  context: string,
) {
  expect(
    legacyBefore.nearBottom,
    `${context}: legacy should start detached`,
  ).toBe(false);
  expect(
    virtualBefore.nearBottom,
    `${context}: virtual should start detached`,
  ).toBe(false);
  expect(
    legacyAfter.nearBottom,
    `${context}: legacy should remain detached`,
  ).toBe(false);
  expect(
    virtualAfter.nearBottom,
    `${context}: virtual should remain detached`,
  ).toBe(false);

  const legacyDelta = Math.abs(legacyAfter.scrollTop - legacyBefore.scrollTop);
  const virtualDelta = Math.abs(
    virtualAfter.scrollTop - virtualBefore.scrollTop,
  );
  expect(
    virtualDelta,
    `${context}: virtual scroll delta (${virtualDelta}px) should not exceed legacy (${legacyDelta}px)`,
  ).toBeLessThanOrEqual(legacyDelta + COPY_SCROLL_DELTA_TOLERANCE_PX);
}

function expectVisibleMessage(
  snapshot: TranscriptScrollSnapshot,
  messageId: string,
  context: string,
) {
  expect(
    snapshot.visibleRows.some((row) => row.messageId === messageId),
    `${context}: ${messageId} should remain visible`,
  ).toBe(true);
}

async function collectVirtualLiveTailLayout(page: Page, messageId: string) {
  return page.evaluate((targetMessageId) => {
    const escapedMessageId = CSS.escape(targetMessageId);
    const list = document.querySelector<HTMLElement>(
      '[data-testid="virtual-message-timeline-list"]',
    );
    const activeRow = document.querySelector<HTMLElement>(
      `[data-virtual-row-message-id="${escapedMessageId}"]`,
    );
    const liveTail = activeRow?.closest<HTMLElement>(
      '[data-testid="virtual-message-timeline-live-tail"]',
    );
    const history = document.querySelector<HTMLElement>(
      '[data-testid="virtual-message-timeline-history"]',
    );

    return {
      historyRows: Number(history?.dataset.virtualHistoryRows ?? 0),
      isInsideLiveTail: liveTail != null,
      liveTailRows: Number(list?.dataset.virtualLiveTailRows ?? 0),
      virtualSize: activeRow?.dataset.virtualRowVirtualSize ?? null,
      virtualStart: activeRow?.dataset.virtualRowVirtualStart ?? null,
    };
  }, messageId);
}

async function installClipboardProbe(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => undefined,
      },
    });
  });
}

function messageRowByText(
  page: Page,
  role: "assistant" | "user",
  text: string,
) {
  return page
    .locator(`[data-role="${role}-message"]`)
    .filter({ hasText: text });
}

async function clickMessageByText(
  page: Page,
  role: "assistant" | "user",
  text: string,
) {
  await messageRowByText(page, role, text).first().click();
  await settleFrames(page);
}

async function clickCopyActionByText(
  page: Page,
  role: "assistant" | "user",
  text: string,
) {
  const row = messageRowByText(page, role, text).first();
  await row.hover();
  const copyButton = row.getByRole("button", { name: "Copy" });
  const box = await copyButton.boundingBox();
  if (!box) {
    throw new Error("copy button should be visible after hover");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await settleFrames(page, 4);
}

async function selectTextByMessageText(
  page: Page,
  role: "assistant" | "user",
  text: string,
) {
  await page.evaluate(
    ({ targetRole, targetText }) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-role="${targetRole}-message"]`,
        ),
      ).find((element) => element.textContent?.includes(targetText));
      if (!row) {
        throw new Error(`message row not found for ${targetText}`);
      }

      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });
      const textNode = walker.nextNode();
      if (!(textNode instanceof Text)) {
        throw new Error("message row should contain selectable text");
      }

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(24, textNode.textContent?.length ?? 0));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { targetRole: role, targetText: text },
  );
  await settleFrames(page, 4);
}

function buildCompletedHugeAssistantFixture(): TranscriptFixture {
  const fixture = buildTranscriptFixture("huge-assistant-output");
  return {
    ...fixture,
    operations: [],
    sessions: fixture.sessions.map((session) => ({
      ...session,
      streamingMessageId: undefined,
      messages: session.messages.map((message) =>
        message.role === "assistant"
          ? {
              ...message,
              metadata: {
                ...message.metadata,
                completionStatus: "completed" as const,
              },
            }
          : message,
      ),
    })),
  };
}

function buildShortStreamingFixture(): TranscriptFixture {
  const fixture = buildTranscriptFixture("huge-assistant-output");
  return {
    ...fixture,
    operations: [],
    sessions: fixture.sessions.map((session) => ({
      ...session,
      streamingMessageId: "huge-assistant-0001",
      messages: session.messages.map((message) =>
        message.id === "huge-assistant-0001"
          ? {
              ...message,
              content: message.content.map((block) =>
                block.type === "text"
                  ? {
                      ...block,
                      text: "Short active streaming response remains bottom-pinned.",
                    }
                  : block,
              ),
              metadata: {
                ...message.metadata,
                completionStatus: "inProgress" as const,
              },
            }
          : message,
      ),
    })),
  };
}

function buildTallStreamingFixture(): TranscriptFixture {
  const fixture = buildTranscriptFixture("huge-assistant-output");
  return {
    ...fixture,
    operations: [],
  };
}

function buildTallStreamingWithHistoryFixture(): TranscriptFixture {
  const fixture = buildTallStreamingFixture();
  return {
    ...fixture,
    sessions: fixture.sessions.map((session) => {
      const historyMessages: Message[] = Array.from(
        { length: 12 },
        (_, index) => {
          const role = index % 2 === 0 ? "user" : "assistant";
          return {
            id: `live-tail-history-${index}`,
            role,
            created: TRANSCRIPT_FIXTURE_BASE_TIME - (12 - index) * 60_000,
            content: [
              {
                type: "text" as const,
                text: `Historical transcript row ${index}`,
              },
            ],
            metadata: {
              userVisible: true,
              agentVisible: true,
              ...(role === "assistant"
                ? { completionStatus: "completed" as const }
                : {}),
            },
          };
        },
      );

      return {
        ...session,
        messages: [...historyMessages, ...session.messages],
      };
    }),
  };
}

function buildStreamingCancelRemountFixture(): TranscriptFixture {
  const fixture = buildTranscriptFixture("streaming-scrollback-long-markdown");
  const primarySession = fixture.sessions[0];
  if (!primarySession) {
    throw new Error("streaming cancel fixture is missing primary session");
  }

  return {
    ...fixture,
    operations: fixture.operations.map((operation) =>
      operation.kind === "startStreamingText"
        ? { ...operation, chunkIntervalMs: 60 }
        : operation,
    ),
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
            metadata: { userVisible: true, agentVisible: true },
          },
        ],
      },
    ],
  };
}

async function wheelTranscript(page: Page, deltaY: number) {
  const scroller = page.getByTestId("message-timeline-scroll");
  const box = await scroller.boundingBox();
  if (!box) {
    throw new Error("transcript scroller should be visible");
  }

  const before = await collectTranscriptScrollSnapshot(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await settleFrames(page, 4);
  const after = await collectTranscriptScrollSnapshot(page);
  return { before, after };
}

function buildIncrementalStreamingFixture(): TranscriptFixture {
  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "huge-assistant-output",
    description:
      "Small active stream used to compare visible chunk cadence between renderers.",
    activeSessionId: INCREMENTAL_STREAMING_SESSION_ID,
    sessions: [
      {
        sessionId: INCREMENTAL_STREAMING_SESSION_ID,
        title: "Incremental streaming parity",
        streamingMessageId: INCREMENTAL_STREAMING_ASSISTANT_ID,
        messages: [
          {
            id: "parity-incremental-streaming-user",
            role: "user",
            created: TRANSCRIPT_FIXTURE_BASE_TIME,
            content: [
              {
                type: "text",
                text: "Stream the answer in visible chunks.",
              },
            ],
            metadata: { userVisible: true, agentVisible: true },
          },
          {
            id: INCREMENTAL_STREAMING_ASSISTANT_ID,
            role: "assistant",
            created: TRANSCRIPT_FIXTURE_BASE_TIME + 60_000,
            content: [{ type: "text", text: "" }],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    ],
    operations: [],
    expectations: {
      logicalMessageCount: 2,
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

async function expectAssistantTextState(
  page: Page,
  expectedText: string,
  unexpectedText: string | null,
  context: string,
) {
  const row = messageRowByText(page, "assistant", expectedText).first();
  await expect(row, context).toBeVisible();
  if (unexpectedText) {
    const laterChunkCount = await messageRowByText(
      page,
      "assistant",
      unexpectedText,
    ).count();
    expect(
      laterChunkCount,
      `${context}: later chunk should not be visible yet`,
    ).toBe(0);
  }
}

async function collectActionGeometry(
  page: Page,
  role: "assistant" | "user",
  text: string,
): Promise<ActionGeometry> {
  const row = messageRowByText(page, role, text).first();
  await row.hover();
  await settleFrames(page, 3);
  const actions = row.locator('[data-role="message-actions"]').first();
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "Copy" })).toBeVisible();

  const geometry = await row.evaluate((element) => {
    const actionsElement = element.querySelector<HTMLElement>(
      '[data-role="message-actions"]',
    );
    if (!actionsElement) {
      throw new Error("message actions should be mounted");
    }

    const rowRect = element.getBoundingClientRect();
    const actionRect = actionsElement.getBoundingClientRect();
    return {
      actionBottomInsetPx: rowRect.bottom - actionRect.bottom,
      actionLeftInsetPx: actionRect.left - rowRect.left,
      actionRightInsetPx: rowRect.right - actionRect.right,
      actionTopPx: actionRect.top - rowRect.top,
      rowHeightPx: rowRect.height,
    };
  });

  return geometry;
}

function expectActionGeometryClose(
  legacy: ActionGeometry,
  virtual: ActionGeometry,
  context: string,
) {
  expect(
    Math.abs(virtual.actionBottomInsetPx - legacy.actionBottomInsetPx),
    `${context}: action bottom inset should match legacy`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(virtual.actionLeftInsetPx - legacy.actionLeftInsetPx),
    `${context}: action left inset should match legacy`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(virtual.actionRightInsetPx - legacy.actionRightInsetPx),
    `${context}: action right inset should match legacy`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(virtual.rowHeightPx - legacy.rowHeightPx),
    `${context}: row height should match legacy`,
  ).toBeLessThanOrEqual(8);
}

async function expectTextVisibleInBoth(
  pair: RendererPair,
  text: string,
  context: string,
) {
  await expect(pair.legacyPage.getByText(text).first(), context).toBeVisible();
  await expect(pair.virtualPage.getByText(text).first(), context).toBeVisible();
}

async function collectElementGeometry(
  page: Page,
  selector: string,
): Promise<ElementGeometry> {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      heightPx: rect.height,
      leftPx: rect.left,
      topPx: rect.top,
      widthPx: rect.width,
    };
  });
}

function expectElementGeometryClose(
  legacy: ElementGeometry,
  virtual: ElementGeometry,
  context: string,
) {
  expect(
    Math.abs(virtual.leftPx - legacy.leftPx),
    `${context}: left edge should match legacy`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(virtual.widthPx - legacy.widthPx),
    `${context}: width should match legacy`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(virtual.heightPx - legacy.heightPx),
    `${context}: height should match legacy`,
  ).toBeLessThanOrEqual(24);
}

test.describe("transcript experiment-on/off parity", () => {
  test("completed transcript initial load lands at latest in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    await withRendererPair(
      context,
      buildCompletedHugeAssistantFixture(),
      async (pair) => {
        await expect(
          pair.legacyPage.getByText("The mutable tail should"),
        ).toBeVisible();
        await expect(
          pair.virtualPage.getByText("The mutable tail should"),
        ).toBeVisible();

        const { legacy, virtual } = await collectPairScroll(pair);
        expectBottomParity(legacy, virtual);
        expectVisibleMessage(
          virtual,
          "huge-assistant-0001",
          "virtual completed load",
        );
      },
    );
  });

  test("short active streaming transcript initial load lands at latest in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    await withRendererPair(
      context,
      buildShortStreamingFixture(),
      async (pair) => {
        await Promise.all([
          settleFrames(pair.legacyPage),
          settleFrames(pair.virtualPage),
        ]);
        await expect(
          pair.legacyPage.getByText("Short active streaming response"),
        ).toBeVisible();
        await expect(
          pair.virtualPage.getByText("Short active streaming response"),
        ).toBeVisible();

        const { legacy, virtual } = await collectPairScroll(pair);
        expectBottomParity(legacy, virtual);
        expectVisibleMessage(
          virtual,
          "huge-assistant-0001",
          "virtual short load",
        );
      },
    );
  });

  test("over-tall active streaming transcript initial load matches legacy anchoring", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    await withRendererPair(
      context,
      buildTallStreamingFixture(),
      async (pair) => {
        await expect(pair.legacyPage.getByText("Requirements")).toBeVisible();
        await expect(pair.virtualPage.getByText("Requirements")).toBeVisible();

        const { legacy, virtual } = await collectPairScroll(pair);
        expect(virtual.nearBottom).toBe(legacy.nearBottom);
        if (legacy.nearBottom) {
          expectBottomParity(legacy, virtual);
        } else {
          expect(virtual.distanceFromBottom).toBeGreaterThan(
            BOTTOM_DISTANCE_TOLERANCE_PX,
          );
        }
        expectVisibleMessage(
          virtual,
          "huge-assistant-0001",
          "virtual tall load",
        );
      },
    );
  });

  test("active streaming response is rendered as a live flow tail in the virtual renderer", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "active streaming live tail requires the production React transcript renderer",
    );

    const page = await context.newPage();
    try {
      await loadTranscriptRenderer(page, {
        rendererUrl,
        rendererMode: "virtual",
        fixture: buildTallStreamingWithHistoryFixture(),
      });

      await expect(page.getByText("Requirements")).toBeVisible();
      const layout = await collectVirtualLiveTailLayout(
        page,
        "huge-assistant-0001",
      );

      expect(
        layout.historyRows,
        "virtual history should still own prior transcript rows",
      ).toBeGreaterThan(0);
      expect(
        layout.liveTailRows,
        "virtual renderer should mount the active turn as a live tail",
      ).toBeGreaterThan(0);
      expect(
        layout.isInsideLiveTail,
        "active streaming assistant row should be inside the live tail",
      ).toBe(true);
      expect(
        layout.virtualStart,
        "active streaming assistant row should not be virtual-positioned",
      ).toBeNull();
      expect(
        layout.virtualSize,
        "active streaming assistant row should not be virtual-measured",
      ).toBeNull();
    } finally {
      await page.close();
    }
  });

  test("scrolled-back message click and copy stay detached in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const userText = "Produce a very large implementation summary with code.";

    await withRendererPair(
      context,
      buildCompletedHugeAssistantFixture(),
      async (pair) => {
        await Promise.all([
          installClipboardProbe(pair.legacyPage),
          installClipboardProbe(pair.virtualPage),
        ]);
        await applyPairOperation(pair, {
          kind: "controlledScrollTarget",
          atMs: 0,
          sessionId: "fixture-huge-output",
          messageId: "huge-user-0000",
        });

        await expect(
          messageRowByText(pair.legacyPage, "user", userText),
        ).toBeVisible();
        await expect(
          messageRowByText(pair.virtualPage, "user", userText),
        ).toBeVisible();
        const beforeClick = await collectPairScroll(pair);

        await clickMessageByText(pair.legacyPage, "user", userText);
        await clickMessageByText(pair.virtualPage, "user", userText);
        const afterClick = await collectPairScroll(pair);

        expectDetachedScrollDeltaNoWorseThanLegacy(
          beforeClick.legacy,
          afterClick.legacy,
          beforeClick.virtual,
          afterClick.virtual,
          "bubble click",
        );
        expectVisibleMessage(
          afterClick.virtual,
          "huge-user-0000",
          "virtual bubble click",
        );

        await clickCopyActionByText(pair.legacyPage, "user", userText);
        await clickCopyActionByText(pair.virtualPage, "user", userText);
        const afterCopy = await collectPairScroll(pair);

        expectDetachedScrollDeltaNoWorseThanLegacy(
          afterClick.legacy,
          afterCopy.legacy,
          afterClick.virtual,
          afterCopy.virtual,
          "copy click",
        );
        expectVisibleMessage(
          afterCopy.virtual,
          "huge-user-0000",
          "virtual copy click",
        );
      },
    );
  });

  test("scrolled-back text selection stays detached in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const userText = "Produce a very large implementation summary with code.";

    await withRendererPair(
      context,
      buildCompletedHugeAssistantFixture(),
      async (pair) => {
        await applyPairOperation(pair, {
          kind: "controlledScrollTarget",
          atMs: 0,
          sessionId: "fixture-huge-output",
          messageId: "huge-user-0000",
        });
        await expect(
          messageRowByText(pair.legacyPage, "user", userText),
        ).toBeVisible();
        await expect(
          messageRowByText(pair.virtualPage, "user", userText),
        ).toBeVisible();

        const beforeSelection = await collectPairScroll(pair);
        await selectTextByMessageText(pair.legacyPage, "user", userText);
        await selectTextByMessageText(pair.virtualPage, "user", userText);
        const afterSelection = await collectPairScroll(pair);

        expectStableDetachedScroll(
          beforeSelection.legacy,
          afterSelection.legacy,
          "legacy text selection",
        );
        expectStableDetachedScroll(
          beforeSelection.virtual,
          afterSelection.virtual,
          "virtual text selection",
          COPY_SCROLL_DELTA_TOLERANCE_PX,
        );
        expectVisibleMessage(
          afterSelection.virtual,
          "huge-user-0000",
          "virtual text selection",
        );
      },
    );
  });

  test("stopped long response remains wheel-scrollable after remount in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const fixture = buildStreamingCancelRemountFixture();
    const session = fixture.sessions[0];
    const otherSession = fixture.sessions[1];
    const assistantId = session?.streamingMessageId;
    const restoreOperation = fixture.operations.find(
      (operation) => operation.kind === "restore",
    );
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );
    if (!session || !otherSession || !assistantId || !restoreOperation) {
      throw new Error("streaming cancel fixture is missing remount inputs");
    }
    if (!startOperation || startOperation.kind !== "startStreamingText") {
      throw new Error("streaming cancel fixture is missing start operation");
    }

    await withRendererPair(context, fixture, async (pair) => {
      await applyPairOperation(pair, restoreOperation);
      await applyPairOperation(pair, startOperation);
      await settleFrames(pair.legacyPage, 8);
      await settleFrames(pair.virtualPage, 8);
      await applyPairOperation(pair, {
        kind: "finishStreamingText",
        atMs: 0,
        sessionId: session.sessionId,
        messageId: assistantId,
        streamId: startOperation.streamId,
      });
      await applyPairOperation(pair, {
        kind: "switchSession",
        atMs: 0,
        fromSessionId: session.sessionId,
        toSessionId: otherSession.sessionId,
        pendingAsyncWork: ["streaming-cancel-remount"],
      });
      await applyPairOperation(pair, {
        kind: "switchSession",
        atMs: 0,
        fromSessionId: otherSession.sessionId,
        toSessionId: session.sessionId,
        pendingAsyncWork: [],
      });
      await applyPairOperation(pair, {
        kind: "controlledScrollTarget",
        atMs: 0,
        sessionId: session.sessionId,
        messageId: assistantId,
      });

      const legacyWheel = await wheelTranscript(pair.legacyPage, 900);
      const virtualWheel = await wheelTranscript(pair.virtualPage, 900);

      expect(
        legacyWheel.after.scrollTop,
        "legacy stopped response should respond to wheel input",
      ).toBeGreaterThan(legacyWheel.before.scrollTop + 80);
      expect(
        virtualWheel.after.scrollTop,
        "virtual stopped response should respond to wheel input",
      ).toBeGreaterThan(virtualWheel.before.scrollTop + 80);
    });
  });

  test("long active streaming scrollback stays detached with visible content in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const fixture = buildTranscriptFixture(
      "streaming-scrollback-long-markdown",
    );
    const session = fixture.sessions[0];
    const assistantId = session?.streamingMessageId;
    const restoreOperation = fixture.operations.find(
      (operation) => operation.kind === "restore",
    );
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );
    if (!session || !assistantId || !restoreOperation || !startOperation) {
      throw new Error("streaming scrollback fixture is missing proof inputs");
    }

    await withRendererPair(context, fixture, async (pair) => {
      await applyPairOperation(pair, restoreOperation);
      await applyPairOperation(pair, startOperation);
      await settleFrames(pair.legacyPage, 8);
      await settleFrames(pair.virtualPage, 8);

      const legacyWheel = await wheelTranscript(pair.legacyPage, -900);
      const virtualWheel = await wheelTranscript(pair.virtualPage, -900);

      expect(
        legacyWheel.after.scrollTop,
        "legacy should honor upward wheel input during active streaming",
      ).toBeLessThan(legacyWheel.before.scrollTop - 80);
      expect(
        virtualWheel.after.scrollTop,
        "virtual should honor upward wheel input during active streaming",
      ).toBeLessThan(virtualWheel.before.scrollTop - 80);
      expect(legacyWheel.after.nearBottom).toBe(false);
      expect(virtualWheel.after.nearBottom).toBe(false);
      expect(legacyWheel.after.visibleRows.length).toBeGreaterThan(0);
      expect(virtualWheel.after.visibleRows.length).toBeGreaterThan(0);

      await pair.legacyPage.waitForTimeout(400);
      await pair.virtualPage.waitForTimeout(400);
      await settleFrames(pair.legacyPage, 4);
      await settleFrames(pair.virtualPage, 4);
      const later = await collectPairScroll(pair);

      expectStableDetachedScroll(
        legacyWheel.after,
        later.legacy,
        "legacy active streaming scrollback",
        96,
      );
      expectStableDetachedScroll(
        virtualWheel.after,
        later.virtual,
        "virtual active streaming scrollback",
        96,
      );
      expect(later.legacy.visibleRows.length).toBeGreaterThan(0);
      expect(later.virtual.visibleRows.length).toBeGreaterThan(0);
    });
  });

  test("finishing an active long stream preserves detached scroll position in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const fixture = buildTranscriptFixture(
      "streaming-scrollback-long-markdown",
    );
    const session = fixture.sessions[0];
    const assistantId = session?.streamingMessageId;
    const restoreOperation = fixture.operations.find(
      (operation) => operation.kind === "restore",
    );
    const startOperation = fixture.operations.find(
      (operation) => operation.kind === "startStreamingText",
    );
    if (!session || !assistantId || !restoreOperation || !startOperation) {
      throw new Error("streaming finish fixture is missing proof inputs");
    }
    if (startOperation.kind !== "startStreamingText") {
      throw new Error("streaming finish fixture is missing stream id");
    }

    await withRendererPair(context, fixture, async (pair) => {
      await applyPairOperation(pair, restoreOperation);
      await applyPairOperation(pair, startOperation);
      await settleFrames(pair.legacyPage, 8);
      await settleFrames(pair.virtualPage, 8);

      const legacyMiddle = await wheelTranscript(pair.legacyPage, -900);
      const virtualMiddle = await wheelTranscript(pair.virtualPage, -900);
      expect(legacyMiddle.after.nearBottom).toBe(false);
      expect(virtualMiddle.after.nearBottom).toBe(false);
      expect(legacyMiddle.after.visibleRows.length).toBeGreaterThan(0);
      expect(virtualMiddle.after.visibleRows.length).toBeGreaterThan(0);

      await applyPairOperation(pair, {
        kind: "finishStreamingText",
        atMs: 0,
        sessionId: session.sessionId,
        messageId: assistantId,
        streamId: startOperation.streamId,
      });
      const afterFinish = await collectPairScroll(pair);

      expect(
        afterFinish.legacy.nearBottom,
        "legacy stream finish should remain detached from latest",
      ).toBe(false);
      expect(
        afterFinish.virtual.nearBottom,
        "virtual stream finish should remain detached from latest",
      ).toBe(false);
      expect(afterFinish.legacy.visibleRows.length).toBeGreaterThan(0);
      expect(afterFinish.virtual.visibleRows.length).toBeGreaterThan(0);
      expectVisibleMessage(
        afterFinish.virtual,
        assistantId,
        "virtual stream finish",
      );
      expect(
        afterFinish.virtual.distanceFromBottom,
        "virtual stream finish should not snap to bottom",
      ).toBeGreaterThan(BOTTOM_DISTANCE_TOLERANCE_PX);
    });
  });

  test("streaming chunks paint incrementally in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const firstChunk = "alpha visible before completion";
    const secondChunk = " beta visible after the next frame";
    const thirdChunk = " gamma visible at the end";
    const streamOperation: TranscriptHarnessOperation = {
      kind: "startStreamingText",
      atMs: 0,
      sessionId: INCREMENTAL_STREAMING_SESSION_ID,
      messageId: INCREMENTAL_STREAMING_ASSISTANT_ID,
      chunks: [firstChunk, secondChunk, thirdChunk],
      chunkIntervalMs: 1_000,
      streamId: "incremental-parity",
    };

    await withRendererPair(
      context,
      buildIncrementalStreamingFixture(),
      async (pair) => {
        await applyPairOperation(pair, streamOperation);
        await settleFrames(pair.legacyPage, 2);
        await settleFrames(pair.virtualPage, 2);

        await expectAssistantTextState(
          pair.legacyPage,
          firstChunk,
          thirdChunk,
          "legacy first streaming chunk",
        );
        await expectAssistantTextState(
          pair.virtualPage,
          firstChunk,
          thirdChunk,
          "virtual first streaming chunk",
        );

        await Promise.all([
          pair.legacyPage.waitForTimeout(1_100),
          pair.virtualPage.waitForTimeout(1_100),
        ]);
        await settleFrames(pair.legacyPage, 2);
        await settleFrames(pair.virtualPage, 2);

        await expectAssistantTextState(
          pair.legacyPage,
          `${firstChunk}${secondChunk}`,
          thirdChunk,
          "legacy second streaming chunk",
        );
        await expectAssistantTextState(
          pair.virtualPage,
          `${firstChunk}${secondChunk}`,
          thirdChunk,
          "virtual second streaming chunk",
        );
      },
    );
  });

  test("completed message hover actions match placement and clipping in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const userText =
      "Keep the last assistant action row clear of the docked composer.";
    const assistantText =
      "Tail response with visible copy and timestamp geometry near the footer.";

    await withRendererPair(
      context,
      buildTranscriptFixture("visual-spacing-date-footer"),
      async (pair) => {
        const userGeometry = {
          legacy: await collectActionGeometry(
            pair.legacyPage,
            "user",
            userText,
          ),
          virtual: await collectActionGeometry(
            pair.virtualPage,
            "user",
            userText,
          ),
        };
        const assistantGeometry = {
          legacy: await collectActionGeometry(
            pair.legacyPage,
            "assistant",
            assistantText,
          ),
          virtual: await collectActionGeometry(
            pair.virtualPage,
            "assistant",
            assistantText,
          ),
        };

        expectActionGeometryClose(
          userGeometry.legacy,
          userGeometry.virtual,
          "user completed actions",
        );
        expectActionGeometryClose(
          assistantGeometry.legacy,
          assistantGeometry.virtual,
          "assistant completed actions",
        );
      },
    );
  });

  test("rich markdown and block content render with matching visible geometry", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    await withRendererPair(
      context,
      buildCompletedHugeAssistantFixture(),
      async (pair) => {
        await applyPairOperation(pair, {
          kind: "controlledScrollTarget",
          atMs: 0,
          sessionId: "fixture-huge-output",
          messageId: "huge-assistant-0001",
        });
        await expectTextVisibleInBoth(
          pair,
          "preserve bottom follow",
          "markdown list item",
        );
        await expectTextVisibleInBoth(pair, "huge answer", "markdown table");
        await expectTextVisibleInBoth(pair, "const row0000", "code fence text");

        const legacyCode = await collectElementGeometry(pair.legacyPage, "pre");
        const virtualCode = await collectElementGeometry(
          pair.virtualPage,
          "pre",
        );
        expectElementGeometryClose(legacyCode, virtualCode, "markdown code");
      },
    );

    await withRendererPair(
      context,
      buildTranscriptFixture("visual-spacing-rich-blocks"),
      async (pair) => {
        await expectTextVisibleInBoth(
          pair,
          "const spacing = measureTranscriptRow();",
          "rich code block",
        );
        await expect(pair.legacyPage.locator("img").first()).toBeVisible();
        await expect(pair.virtualPage.locator("img").first()).toBeVisible();

        const selectors = [
          {
            label: "tool",
            selector:
              '[data-role="tool-chain-card"], [data-role="tool-single"]',
          },
          { label: "code", selector: "pre" },
          { label: "image", selector: "img" },
        ];
        for (const { label, selector } of selectors) {
          const legacy = await collectElementGeometry(
            pair.legacyPage,
            selector,
          );
          const virtual = await collectElementGeometry(
            pair.virtualPage,
            selector,
          );
          expectElementGeometryClose(legacy, virtual, label);
        }
      },
    );
  });

  test("composer growth and session switch preserve latest-position parity", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const fixture = buildTranscriptFixture("composer-growth-session-switch");
    await withRendererPair(context, fixture, async (pair) => {
      for (const operation of fixture.operations) {
        await applyPairOperation(pair, operation);

        if (
          operation.kind === "restore" ||
          operation.kind === "composerResize" ||
          operation.kind === "toggleSurface"
        ) {
          const { legacy, virtual } = await collectPairScroll(pair);
          expect(virtual.nearBottom).toBe(legacy.nearBottom);
          if (legacy.nearBottom) {
            expectBottomParity(legacy, virtual);
          }
        }
      }

      await expectTextVisibleInBoth(
        pair,
        "reply 00119 assistant validates fragment tail",
        "secondary session tail",
      );
      const { legacy, virtual } = await collectPairScroll(pair);
      expectBottomParity(legacy, virtual);
    });
  });

  test("PR928 row revision, split, and tail promotion preserve viewport in both renderers", async ({
    context,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "experiment parity requires the production React transcript renderer",
    );

    const fixture = buildTranscriptFixture("pr928-fragment-tail");
    const preservingOperationKinds = new Set<
      TranscriptHarnessOperation["kind"]
    >(["changeRowRevision", "splitMessageRows", "promoteStreamingTail"]);

    await withRendererPair(context, fixture, async (pair) => {
      for (const operation of fixture.operations) {
        if (!preservingOperationKinds.has(operation.kind)) {
          await applyPairOperation(pair, operation);
          continue;
        }

        const { before, after } = await applyPairOperationWithScrollSnapshots(
          pair,
          operation,
        );
        expectStableDetachedScroll(
          before.legacy,
          after.legacy,
          `legacy ${operation.kind}`,
          32,
        );
        expectStableDetachedScroll(
          before.virtual,
          after.virtual,
          `virtual ${operation.kind}`,
          32,
        );
        expect(
          after.virtual.visibleRows.length,
          `virtual ${operation.kind} should keep content mounted`,
        ).toBeGreaterThan(0);
      }
    });
  });
});
