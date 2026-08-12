import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptFixture,
  type TranscriptHarnessOperation,
  type TranscriptRendererMode,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import {
  loadTranscriptRenderer,
  playTranscriptOperations,
} from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;

const STRICT_PARITY_TOLERANCE_PX = 2;
const BLOCK_OFFSET_TOLERANCE_PX = 3;
const FOOTER_ACTION_CLEARANCE_PX = 8;
const FRAGMENT_CONTINUATION_GAP_TOLERANCE_PX = 2;

interface RectSnapshot {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface DateFooterGeometry {
  dateToBubbleGapPx: number;
  dateRowToBubbleGapPx: number;
  assistantLeftGutterPx: number;
  userRightGutterPx: number;
  userBubbleWidthPx: number;
  tailActionFooterClearancePx: number;
  tailActionBottomPx: number;
  footerTopPx: number;
}

interface FragmentGeometry {
  legacyContentLeftPx: number | null;
  virtualFragmentCount: number;
  virtualFragmentGapsPx: number[];
  virtualFirstFragmentLeftPx: number;
  virtualLastActionTopPx: number | null;
  virtualLastFragmentBottomPx: number;
}

interface RichBlockGeometry {
  assistantLeftGutterPx: number;
  assistantContentWidthPx: number;
  userRightGutterPx: number;
  userBubbleWidthPx: number;
  blockOffsetsPx: Record<string, number>;
  blockWidthsPx: Record<string, number>;
}

async function waitForStableLayout(page: Page) {
  await page.evaluate(async () => {
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await waitForFrame();
    await waitForFrame();
    await waitForFrame();
  });
}

async function applyVisualOperation(
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
  await waitForStableLayout(page);
}

async function loadVisualFixture(
  context: BrowserContext,
  rendererMode: TranscriptRendererMode,
  fixture: TranscriptFixture,
) {
  const page = await context.newPage();
  await loadTranscriptRenderer(page, {
    rendererUrl,
    rendererMode,
    fixture,
  });
  await playTranscriptOperations(page, fixture.operations);
  await waitForStableLayout(page);
  return page;
}

async function collectForBothRenderers<T>(
  context: BrowserContext,
  fixture: TranscriptFixture,
  collect: (page: Page) => Promise<T>,
) {
  const legacyPage = await loadVisualFixture(context, "legacy", fixture);
  const virtualPage = await loadVisualFixture(context, "virtual", fixture);
  try {
    const [legacy, virtual] = await Promise.all([
      collect(legacyPage),
      collect(virtualPage),
    ]);
    return { legacy, virtual };
  } finally {
    await legacyPage.close();
    await virtualPage.close();
  }
}

function expectNumberCloseTo(
  actual: number,
  expected: number,
  tolerancePx: number,
  message: string,
) {
  expect(Math.abs(actual - expected), message).toBeLessThanOrEqual(tolerancePx);
}

test.describe("transcript visual spacing parity", () => {
  test("keeps date separator, gutter, bubble width, and footer action geometry aligned", async ({
    context,
  }) => {
    const fixture = buildTranscriptFixture("visual-spacing-date-footer");
    const { legacy, virtual } = await collectForBothRenderers(
      context,
      fixture,
      collectDateFooterGeometry,
    );

    expectNumberCloseTo(
      virtual.dateToBubbleGapPx,
      legacy.dateToBubbleGapPx,
      STRICT_PARITY_TOLERANCE_PX,
      "date label to following bubble spacing should match legacy",
    );
    expectNumberCloseTo(
      virtual.dateRowToBubbleGapPx,
      legacy.dateRowToBubbleGapPx,
      STRICT_PARITY_TOLERANCE_PX,
      "date separator row to following bubble spacing should match legacy",
    );
    expectNumberCloseTo(
      virtual.assistantLeftGutterPx,
      legacy.assistantLeftGutterPx,
      STRICT_PARITY_TOLERANCE_PX,
      "assistant left gutter should match legacy",
    );
    expectNumberCloseTo(
      virtual.userRightGutterPx,
      legacy.userRightGutterPx,
      STRICT_PARITY_TOLERANCE_PX,
      "user right gutter should match legacy",
    );
    expectNumberCloseTo(
      virtual.userBubbleWidthPx,
      legacy.userBubbleWidthPx,
      STRICT_PARITY_TOLERANCE_PX,
      "user bubble width should match legacy",
    );
    expect(
      legacy.tailActionFooterClearancePx,
      "legacy tail actions should remain above the composer footer",
    ).toBeGreaterThanOrEqual(FOOTER_ACTION_CLEARANCE_PX);
    expect(
      virtual.tailActionFooterClearancePx,
      "virtual tail actions should remain above the composer footer",
    ).toBeGreaterThanOrEqual(FOOTER_ACTION_CLEARANCE_PX);
    expectNumberCloseTo(
      virtual.tailActionFooterClearancePx,
      legacy.tailActionFooterClearancePx,
      STRICT_PARITY_TOLERANCE_PX,
      "virtual footer/action clearance should match legacy",
    );
  });

  test("does not add visible gaps between virtual fragments of one assistant answer", async ({
    context,
  }) => {
    const fixture = buildTranscriptFixture(
      "visual-spacing-fragmented-assistant",
    );
    const { legacy, virtual } = await collectForBothRenderers(
      context,
      fixture,
      collectFragmentGeometry,
    );

    expect(legacy.legacyContentLeftPx).not.toBeNull();
    expect(virtual.virtualFragmentCount).toBeGreaterThan(1);
    expectNumberCloseTo(
      virtual.virtualFirstFragmentLeftPx,
      legacy.legacyContentLeftPx ?? 0,
      STRICT_PARITY_TOLERANCE_PX,
      "virtual assistant fragment left edge should match legacy assistant content",
    );
    expect(
      Math.max(...virtual.virtualFragmentGapsPx),
      "fragment rows from one assistant answer should visually stitch together",
    ).toBeLessThanOrEqual(FRAGMENT_CONTINUATION_GAP_TOLERANCE_PX);
    expect(
      virtual.virtualLastActionTopPx,
      "only the last assistant fragment should expose the action tray",
    ).not.toBeNull();
    expect(
      virtual.virtualLastActionTopPx ?? 0,
      "last-fragment action tray should stay attached to the end of the answer",
    ).toBeGreaterThanOrEqual(virtual.virtualLastFragmentBottomPx - 48);
  });

  test("preserves rich assistant block offsets in desktop and compact layouts", async ({
    context,
  }) => {
    const fixture = buildTranscriptFixture("visual-spacing-rich-blocks");
    const { legacy, virtual } = await collectForBothRenderers(
      context,
      fixture,
      collectRichBlockGeometry,
    );

    expectNumberCloseTo(
      virtual.assistantLeftGutterPx,
      legacy.assistantLeftGutterPx,
      STRICT_PARITY_TOLERANCE_PX,
      "rich assistant left gutter should match legacy",
    );
    expectNumberCloseTo(
      virtual.assistantContentWidthPx,
      legacy.assistantContentWidthPx,
      STRICT_PARITY_TOLERANCE_PX,
      "rich assistant content width should match legacy",
    );
    expectNumberCloseTo(
      virtual.userRightGutterPx,
      legacy.userRightGutterPx,
      STRICT_PARITY_TOLERANCE_PX,
      "rich fixture user gutter should match legacy",
    );
    expectNumberCloseTo(
      virtual.userBubbleWidthPx,
      legacy.userBubbleWidthPx,
      STRICT_PARITY_TOLERANCE_PX,
      "rich fixture user bubble width should match legacy",
    );

    for (const blockName of ["reasoning", "tool", "code", "image", "mcp"]) {
      expectNumberCloseTo(
        virtual.blockOffsetsPx[blockName],
        legacy.blockOffsetsPx[blockName],
        BLOCK_OFFSET_TOLERANCE_PX,
        `${blockName} block left offset should match legacy`,
      );
      expectNumberCloseTo(
        virtual.blockWidthsPx[blockName],
        legacy.blockWidthsPx[blockName],
        BLOCK_OFFSET_TOLERANCE_PX,
        `${blockName} block width should match legacy`,
      );
    }
  });
});

async function collectDateFooterGeometry(
  page: Page,
): Promise<DateFooterGeometry> {
  await applyVisualOperation(page, {
    kind: "controlledScrollTarget",
    atMs: 0,
    sessionId: "fixture-visual-spacing-date-footer",
    messageId: "spacing-day2-user",
  });

  const dateAndGutterGeometry = await page.evaluate(() => {
    const rect = (element: Element): RectSnapshot => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const requireElement = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing element for selector: ${selector}`);
      }
      return element;
    };
    const messageBubbleByText = (role: "assistant" | "user", text: string) => {
      const bubble = Array.from(
        document.querySelectorAll(`[data-role="${role}-message"]`),
      ).find(
        (candidate): candidate is HTMLElement =>
          candidate instanceof HTMLElement &&
          (candidate.textContent ?? "").includes(text),
      );
      if (!bubble) {
        throw new Error(`Missing ${role} message containing: ${text}`);
      }
      return bubble;
    };
    const messageRow = (
      role: "assistant" | "user",
      text: string,
      messageId: string,
    ) => {
      const contentSelector = `[data-role="${role}-message-content"]`;
      const virtualRows = Array.from(
        document.querySelectorAll(
          `[data-virtual-row-message-id="${CSS.escape(messageId)}"]`,
        ),
      ).filter((row): row is HTMLElement => row instanceof HTMLElement);
      const virtualMessageRow = virtualRows.find((row) =>
        row.querySelector(contentSelector),
      );
      if (virtualMessageRow) {
        return virtualMessageRow;
      }
      const bubble = messageBubbleByText(role, text);
      return bubble.parentElement ?? bubble;
    };
    const findDateSpan = (row: HTMLElement) => {
      const findIn = (root: ParentNode) =>
        Array.from(root.querySelectorAll("span")).find(
          (span): span is HTMLSpanElement =>
            span instanceof HTMLSpanElement &&
            getComputedStyle(span).fontSize === "11px",
        );
      const localDateSpan = findIn(row);
      if (localDateSpan) {
        return localDateSpan;
      }
      let previous = row.previousElementSibling;
      while (previous) {
        if (
          previous instanceof HTMLElement &&
          previous.dataset.virtualRowKind === "date-separator"
        ) {
          const dateSpan = findIn(previous);
          if (dateSpan) {
            return dateSpan;
          }
        }
        previous = previous.previousElementSibling;
      }
      throw new Error("Missing date separator span before day-two row");
    };

    const scroller = rect(
      requireElement('[data-testid="message-timeline-scroll"]'),
    );
    const dayTwoRow = messageRow(
      "user",
      "The second day starts here",
      "spacing-day2-user",
    );
    const dayTwoBubble = rect(
      requireElement('[data-role="user-message-content"]', dayTwoRow),
    );
    const dateSpan = findDateSpan(dayTwoRow);
    const date = rect(dateSpan);
    const dateContainer = rect(dateSpan.parentElement ?? dateSpan);
    const assistantContent = rect(
      requireElement(
        '[data-role="assistant-message-content"]',
        messageRow(
          "assistant",
          "Assistant bubble after the date separator",
          "spacing-day2-assistant",
        ),
      ),
    );
    return {
      dateToBubbleGapPx: dayTwoBubble.top - date.bottom,
      dateRowToBubbleGapPx: dayTwoBubble.top - dateContainer.bottom,
      assistantLeftGutterPx: assistantContent.left - scroller.left,
      userRightGutterPx: scroller.right - dayTwoBubble.right,
      userBubbleWidthPx: dayTwoBubble.width,
    };
  });

  await applyVisualOperation(page, {
    kind: "restore",
    atMs: 0,
    sessionId: "fixture-visual-spacing-date-footer",
    scrollPosition: "tail",
  });

  const footerGeometry = await page.evaluate(() => {
    const rect = (element: Element): RectSnapshot => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const requireElement = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing element for selector: ${selector}`);
      }
      return element;
    };
    const tailBubble = Array.from(
      document.querySelectorAll('[data-role="assistant-message"]'),
    ).find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        (candidate.textContent ?? "").includes(
          "Tail response with visible copy",
        ),
    );
    if (!tailBubble) {
      throw new Error("Missing tail assistant message");
    }
    const footer = rect(
      requireElement('[data-testid="message-timeline-footer"]'),
    );
    const tailActions = rect(
      requireElement('[data-role="message-actions"]', tailBubble),
    );

    return {
      tailActionFooterClearancePx: footer.top - tailActions.bottom,
      tailActionBottomPx: tailActions.bottom,
      footerTopPx: footer.top,
    };
  });

  return { ...dateAndGutterGeometry, ...footerGeometry };
}

async function collectFragmentGeometry(page: Page): Promise<FragmentGeometry> {
  await applyVisualOperation(page, {
    kind: "controlledScrollTarget",
    atMs: 0,
    sessionId: "fixture-visual-spacing-fragmented-assistant",
    messageId: "spacing-fragment-assistant",
  });

  return page.evaluate(() => {
    const rect = (element: Element): RectSnapshot => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const requireElement = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing element for selector: ${selector}`);
      }
      return element;
    };
    const legacyBubble = Array.from(
      document.querySelectorAll('[data-role="assistant-message"]'),
    ).find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        (candidate.textContent ?? "").includes("Fragment parity line 000"),
    );
    const legacyContent = legacyBubble?.querySelector(
      '[data-role="assistant-message-content"]',
    );
    const legacyContentRect =
      legacyContent instanceof HTMLElement ? rect(legacyContent) : null;
    const fragmentRows = Array.from(
      document.querySelectorAll(
        '[data-virtual-row-kind="assistant-content-fragment"][data-virtual-row-message-id="spacing-fragment-assistant"]',
      ),
    ).filter((row): row is HTMLElement => row instanceof HTMLElement);

    if (fragmentRows.length === 0) {
      return {
        legacyContentLeftPx: legacyContentRect?.left ?? null,
        virtualFragmentCount: 0,
        virtualFragmentGapsPx: [],
        virtualFirstFragmentLeftPx: 0,
        virtualLastActionTopPx: null,
        virtualLastFragmentBottomPx: 0,
      };
    }

    const fragmentRects = fragmentRows
      .map(rect)
      .sort((left, right) => left.top - right.top);
    const contentRects = fragmentRows
      .map((row) =>
        requireElement('[data-role="assistant-message-content"]', row),
      )
      .map(rect)
      .sort((left, right) => left.top - right.top);
    const gaps = contentRects.slice(1).map((current, index) => {
      const previous = contentRects[index];
      return previous ? current.top - previous.bottom : 0;
    });
    const lastFragment = fragmentRows.at(-1);
    const lastActions = lastFragment?.querySelector(
      '[data-role="message-actions"]',
    );

    return {
      legacyContentLeftPx: legacyContentRect?.left ?? null,
      virtualFragmentCount: fragmentRows.length,
      virtualFragmentGapsPx: gaps,
      virtualFirstFragmentLeftPx: contentRects[0]?.left ?? 0,
      virtualLastActionTopPx:
        lastActions instanceof HTMLElement ? rect(lastActions).top : null,
      virtualLastFragmentBottomPx: fragmentRects.at(-1)?.bottom ?? 0,
    };
  });
}

async function collectRichBlockGeometry(
  page: Page,
): Promise<RichBlockGeometry> {
  await applyVisualOperation(page, {
    kind: "controlledScrollTarget",
    atMs: 0,
    sessionId: "fixture-visual-spacing-rich-blocks",
    messageId: "spacing-rich-user",
  });

  return page.evaluate(() => {
    const rect = (element: Element): RectSnapshot => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const requireElement = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing element for selector: ${selector}`);
      }
      return element;
    };
    const messageBubbleByText = (role: "assistant" | "user", text: string) => {
      const bubble = Array.from(
        document.querySelectorAll(`[data-role="${role}-message"]`),
      ).find(
        (candidate): candidate is HTMLElement =>
          candidate instanceof HTMLElement &&
          (candidate.textContent ?? "").includes(text),
      );
      if (!bubble) {
        throw new Error(`Missing ${role} message containing: ${text}`);
      }
      return bubble;
    };
    const messageRow = (
      role: "assistant" | "user",
      text: string,
      messageId: string,
    ) => {
      const contentSelector = `[data-role="${role}-message-content"]`;
      const virtualRows = Array.from(
        document.querySelectorAll(
          `[data-virtual-row-message-id="${CSS.escape(messageId)}"]`,
        ),
      ).filter((row): row is HTMLElement => row instanceof HTMLElement);
      const virtualMessageRow = virtualRows.find((row) =>
        row.querySelector(contentSelector),
      );
      if (virtualMessageRow) {
        return virtualMessageRow;
      }
      const bubble = messageBubbleByText(role, text);
      return bubble.parentElement ?? bubble;
    };
    const scroller = rect(
      requireElement('[data-testid="message-timeline-scroll"]'),
    );
    const userContent = rect(
      requireElement(
        '[data-role="user-message-content"]',
        messageRow(
          "user",
          "Show reasoning, tools, MCP UI",
          "spacing-rich-user",
        ),
      ),
    );
    const assistantRow = messageRow(
      "assistant",
      "The code block should align",
      "spacing-rich-assistant",
    );
    const assistantContentElement = requireElement(
      '[data-role="assistant-message-content"]',
      assistantRow,
    );
    const assistantContent = rect(assistantContentElement);
    const blockSelectors = {
      reasoning: "button",
      tool: '[data-role="tool-chain-card"], [data-role="tool-single"]',
      code: "pre",
      image: "button[aria-label] img",
      mcp: '[data-testid="mcp-app-view"]',
    };
    const blockOffsetsPx: Record<string, number> = {};
    const blockWidthsPx: Record<string, number> = {};

    for (const [name, selector] of Object.entries(blockSelectors)) {
      const blockRect = rect(requireElement(selector, assistantContentElement));
      blockOffsetsPx[name] = blockRect.left - assistantContent.left;
      blockWidthsPx[name] = blockRect.width;
    }

    return {
      assistantLeftGutterPx: assistantContent.left - scroller.left,
      assistantContentWidthPx: assistantContent.width,
      userRightGutterPx: scroller.right - userContent.right,
      userBubbleWidthPx: userContent.width,
      blockOffsetsPx,
      blockWidthsPx,
    };
  });
}
