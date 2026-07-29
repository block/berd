import { expect, test, type Page } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptFixture,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY } from "../../src/features/chat/transcript/row-state/transcriptRowStateRegistry";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import {
  collectTranscriptScrollSnapshot,
  loadTranscriptRenderer,
  waitForStableTranscriptScrollSnapshot,
} from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;
const requiresRealRenderer = rendererUrl !== LOCAL_TRANSCRIPT_RENDERER_URL;
// Selection can trigger a small local layout nudge; the product contract is
// that it does not jump the user back to latest and keeps selected content in view.
const MAX_SCROLLBACK_SELECTION_SCROLL_DRIFT_PX = 96;

interface TranscriptHarnessWindow extends Window {
  __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: {
    applyOperation?: (operation: {
      kind: string;
      atMs: number;
      sessionId?: string;
      messageId?: string;
      active?: boolean;
      sourceId?: string;
      nowMs?: number;
      ttlMs?: number;
      waitForVisible?: boolean;
    }) => void | Promise<void>;
    collectDiagnostics?: () =>
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
    getRowIdForMessage?: (messageId: string) => string;
  };
  __GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__?: {
    protectedRows?: number;
    protectedOffscreenRows?: number;
    forcedProtectedRowCount?: number;
    mcpCandidateCount?: number;
    mcpProtectedRowCount?: number;
    evictedMcpRowCount?: number;
    acceptedOffscreenShellMeasurements?: number;
    acceptedOffscreenRealMeasurements?: number;
    blankViewportPixels?: number;
  };
  find?: (
    string: string,
    caseSensitive?: boolean,
    backwards?: boolean,
    wrap?: boolean,
  ) => boolean;
}

async function browserFind(page: Page, token: string): Promise<boolean> {
  return page.evaluate((needle) => {
    window.getSelection()?.removeAllRanges();
    return Boolean(
      (window as TranscriptHarnessWindow).find?.(needle, false, false, true),
    );
  }, token);
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

async function scrollToMessage(
  page: Page,
  fixture: TranscriptFixture,
  messageId: string,
) {
  await applyHarnessOperation(page, {
    kind: "controlledScrollTarget",
    atMs: 0,
    sessionId: fixture.activeSessionId,
    messageId,
    waitForVisible: true,
  });
  await page.waitForFunction(
    (targetMessageId) => {
      const scroller = document.querySelector(
        '[data-testid="message-timeline-scroll"]',
      );
      if (!(scroller instanceof HTMLElement)) {
        return false;
      }

      const escapedMessageId = CSS.escape(targetMessageId);
      const rows = Array.from(
        scroller.querySelectorAll<HTMLElement>(
          [
            `[data-transcript-message-id="${escapedMessageId}"]`,
            `[data-virtual-row-message-id="${escapedMessageId}"]`,
            "[data-virtual-row-id]",
          ].join(","),
        ),
      ).filter(
        (row) =>
          row.dataset.transcriptMessageId === targetMessageId ||
          row.dataset.virtualRowMessageId === targetMessageId ||
          row.dataset.virtualRowId === `message:${targetMessageId}`,
      );
      const scrollerRect = scroller.getBoundingClientRect();
      return rows.some((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.bottom > scrollerRect.top + 1 &&
          rect.top < scrollerRect.bottom - 1
        );
      });
    },
    messageId,
    { timeout: 10_000 },
  );
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

async function applyHarnessOperation(
  page: Page,
  operation: {
    kind: string;
    atMs: number;
    sessionId?: string;
    messageId?: string;
    active?: boolean;
    sourceId?: string;
    nowMs?: number;
    ttlMs?: number;
    waitForVisible?: boolean;
  },
) {
  await page.evaluate(async (nextOperation) => {
    await (
      window as TranscriptHarnessWindow
    ).__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.applyOperation?.(nextOperation);
  }, operation);
  await settleFrames(page);
}

async function collectHarnessDiagnostics(page: Page) {
  const diagnostics = await page.evaluate(async () => {
    const diagnostics = await (
      window as TranscriptHarnessWindow
    ).__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.collectDiagnostics?.();
    return {
      ...(diagnostics ?? {}),
      ...((window as TranscriptHarnessWindow)
        .__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__ ?? {}),
    };
  });

  if (typeof diagnostics.forcedProtectedRowCount === "number") {
    return diagnostics;
  }

  const forcedProtectedRowCount = deriveForcedProtectedRowCount(
    diagnostics.rows,
  );
  return forcedProtectedRowCount == null
    ? diagnostics
    : { ...diagnostics, forcedProtectedRowCount };
}

function deriveForcedProtectedRowCount(rows: unknown): number | null {
  if (!Array.isArray(rows)) {
    return null;
  }

  const forcedReasons = new Set([
    "active-stream",
    "focused",
    "open-overlay",
    "selection",
  ]);
  return rows.reduce((count, row) => {
    if (typeof row !== "object" || row === null) {
      return count;
    }

    const reasons = (row as { reasons?: unknown }).reasons;
    if (!Array.isArray(reasons)) {
      return count;
    }

    return reasons.some(
      (reason) => typeof reason === "string" && forcedReasons.has(reason),
    )
      ? count + 1
      : count;
  }, 0);
}

async function waitForVirtualDiagnostics(
  page: Page,
  expectedDiagnostics: Record<string, number>,
) {
  try {
    await page.waitForFunction(
      (expected) => {
        const diagnostics = (window as TranscriptHarnessWindow)
          .__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__;
        if (!diagnostics) {
          return false;
        }

        return Object.entries(expected).every(([key, value]) => {
          const actual = (diagnostics as Record<string, unknown>)[key];
          return typeof actual === "number" && actual === value;
        });
      },
      expectedDiagnostics,
      { timeout: 5_000 },
    );
  } catch (error) {
    const diagnostics = await collectHarnessDiagnostics(page);
    throw new Error(
      `Timed out waiting for virtual diagnostics ${JSON.stringify(
        expectedDiagnostics,
      )}; last diagnostics ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

async function messageRowSelector(
  page: Page,
  messageId: string,
): Promise<string> {
  const rowId = await page.evaluate(
    (id) =>
      (
        window as TranscriptHarnessWindow
      ).__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.getRowIdForMessage?.(id),
    messageId,
  );
  return `[data-virtual-row-id="${rowId ?? `message:${messageId}`}"]`;
}

async function waitForProtectedRows(page: Page, protectedRows: number) {
  await page.waitForFunction(
    (expectedProtectedRows) => {
      const diagnostics = (window as TranscriptHarnessWindow)
        .__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__;
      return diagnostics?.protectedRows === expectedProtectedRows;
    },
    protectedRows,
    { timeout: 5_000 },
  );
}

async function selectTextAcrossMessages(
  page: Page,
  startMessageId: string,
  endMessageId: string,
) {
  await page.evaluate(
    ({ firstMessageId, lastMessageId }) => {
      function findTextNode(element: Element): Text {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) =>
              node.textContent?.trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT,
          },
        );
        const textNode = walker.nextNode();
        if (!(textNode instanceof Text)) {
          throw new Error("message row has no selectable text node");
        }
        return textNode;
      }

      const firstRow = document.querySelector(
        `[data-transcript-message-id="${CSS.escape(firstMessageId)}"]`,
      );
      const lastRow = document.querySelector(
        `[data-transcript-message-id="${CSS.escape(lastMessageId)}"]`,
      );
      if (!firstRow || !lastRow) {
        throw new Error("message rows must be mounted before selection");
      }

      const firstTextNode = findTextNode(firstRow);
      const lastTextNode = findTextNode(lastRow);
      const range = document.createRange();
      range.setStart(firstTextNode, 0);
      range.setEnd(lastTextNode, lastTextNode.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { firstMessageId: startMessageId, lastMessageId: endMessageId },
  );
  await settleFrames(page);
}

async function selectTextInMessage(page: Page, messageId: string) {
  await page.evaluate((targetMessageId) => {
    function findTextNode(element: Element): Text {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });
      const textNode = walker.nextNode();
      if (!(textNode instanceof Text)) {
        throw new Error("message row has no selectable text node");
      }
      return textNode;
    }

    const row = document.querySelector(
      `[data-transcript-message-id="${CSS.escape(targetMessageId)}"]`,
    );
    if (!row) {
      throw new Error("message row must be mounted before selection");
    }

    const textNode = findTextNode(row);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(textNode.textContent?.length ?? 0, 24));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, messageId);
  await settleFrames(page);
}

async function clickMessageCopyButton(page: Page, messageId: string) {
  const messageRow = page
    .locator(`[data-transcript-message-id="${messageId}"]`)
    .first();
  await messageRow.hover();
  const copyButton = messageRow.getByRole("button", { name: "Copy" });
  const box = await copyButton.boundingBox();
  if (!box) {
    throw new Error("message copy button must be visible before click");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await settleFrames(page, 4);
}

async function clearBrowserSelection(page: Page) {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await settleFrames(page);
}

async function setSelectedTextMenuOpen(
  page: Page,
  messageId: string,
  open: boolean,
) {
  await page.evaluate(
    ({ targetMessageId, nextOpen }) => {
      const row = document.querySelector(
        `[data-transcript-message-id="${CSS.escape(targetMessageId)}"]`,
      );
      const ranges: Range[] = [];
      if (row) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.textContent?.trim()
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT,
        });
        const textNode = walker.nextNode();
        if (textNode instanceof Text) {
          const range = document.createRange();
          range.setStart(textNode, 0);
          range.setEnd(textNode, Math.min(16, textNode.textContent.length));
          ranges.push(range);
        }
      }

      window.dispatchEvent(
        new CustomEvent("goose:transcript-selected-text-context-menu", {
          detail: { open: nextOpen, ranges },
        }),
      );
    },
    { targetMessageId: messageId, nextOpen: open },
  );
  await settleFrames(page);
}

test.describe("transcript product contract proof", () => {
  test("virtual renderer loads completed transcripts at the bottom", async ({
    page,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "initial bottom positioning requires the production React transcript renderer",
    );

    const fixture = buildCompletedHugeAssistantFixture();

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await expect(page.getByText("The mutable tail should")).toBeVisible();
    const snapshot = await collectTranscriptScrollSnapshot(page);
    const assistantTail = snapshot.visibleRows.find(
      (row) => row.messageId === "huge-assistant-0001",
    );

    expect(snapshot.nearBottom).toBe(true);
    expect(snapshot.distanceFromBottom).toBeLessThanOrEqual(8);
    expect(assistantTail).not.toBeUndefined();
    expect(assistantTail?.bottomPx).toBeLessThanOrEqual(
      snapshot.clientHeight + 1,
    );
  });

  test("native find is bounded to the mounted virtual DOM window", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("long-10k");
    const mountedToken =
      "reply 09999 assistant validates MCP resize with stable row identity.";
    const initiallyUnmountedToken =
      "request 00000 user validates projection cache with stable row identity.";

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await expect(page.getByText(mountedToken)).toBeVisible();
    await expect(page.getByText(initiallyUnmountedToken)).toHaveCount(0);
    expect(await browserFind(page, mountedToken)).toBe(true);
    expect(await browserFind(page, initiallyUnmountedToken)).toBe(false);

    await scrollToMessage(page, fixture, "long-00000");

    await expect(page.getByText(initiallyUnmountedToken)).toBeVisible();
    expect(await browserFind(page, initiallyUnmountedToken)).toBe(true);
  });

  test("offscreen shell measurement text is hidden from native find and the live log", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("long-10k");

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    const offscreenShellMessageId = await page.evaluate(() => {
      const shellRow = document.querySelector(
        [
          '[data-testid="virtual-offscreen-measurement-host"]',
          '[data-virtual-row-offscreen-shell-id^="message:"]',
        ].join(" "),
      );
      const rowId = shellRow?.getAttribute(
        "data-virtual-row-offscreen-shell-id",
      );
      return rowId?.startsWith("message:")
        ? rowId.slice("message:".length)
        : null;
    });
    const offscreenShellUniqueToken = await page.evaluate(() => {
      const shellRow = document.querySelector(
        [
          '[data-testid="virtual-offscreen-measurement-host"]',
          '[data-virtual-row-offscreen-shell-id^="message:"]',
        ].join(" "),
      );
      return (
        shellRow?.getAttribute("data-virtual-row-shell-unique-token") ?? null
      );
    });
    expect(offscreenShellMessageId).not.toBeNull();
    expect(offscreenShellUniqueToken).toBeTruthy();
    const offscreenShellMessage = fixture.sessions[0]?.messages.find(
      (message) => message.id === offscreenShellMessageId,
    );
    const offscreenShellToken = offscreenShellMessage?.content.find(
      (block) => block.type === "text",
    )?.text;
    expect(offscreenShellToken).toBeTruthy();

    const offscreenHost = page.getByTestId(
      "virtual-offscreen-measurement-host",
    );
    await expect(offscreenHost).toHaveAttribute("aria-hidden", "true");
    await expect(offscreenHost).toHaveText("");
    await expect(page.getByRole("log")).toHaveCount(1);
    expect(await browserFind(page, offscreenShellToken ?? "")).toBe(false);
    expect(await browserFind(page, offscreenShellUniqueToken ?? "")).toBe(
      false,
    );

    const offscreenRealHost = page.getByTestId(
      "virtual-offscreen-real-measurement-host",
    );
    if ((await offscreenRealHost.count()) > 0) {
      await expect(offscreenRealHost).toHaveAttribute("aria-hidden", "true");
      await expect(offscreenRealHost).toHaveAttribute(
        "data-transcript-search-skip",
        "",
      );
      await expect(
        offscreenRealHost.locator(
          [
            "[data-transcript-message-id]",
            "[data-virtual-row-message-id]",
            "[data-virtual-row-id]",
          ].join(","),
        ),
      ).toHaveCount(0);
    }
  });

  test("DOM selection does not promote selected rows into keepalive", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("long-10k");
    const firstSelectedMessageId = "long-09998";
    const secondSelectedMessageId = "long-09999";

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await expect(
      page.locator(`[data-transcript-message-id="${firstSelectedMessageId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-transcript-message-id="${secondSelectedMessageId}"]`),
    ).toBeVisible();

    await selectTextAcrossMessages(
      page,
      firstSelectedMessageId,
      secondSelectedMessageId,
    );
    await waitForProtectedRows(page, 0);

    await clearBrowserSelection(page);
    await waitForProtectedRows(page, 0);
  });

  test("DOM selection while scrolled back does not jump to latest", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("long-10k");
    const selectedMessageId = "long-09940";

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await scrollToMessage(page, fixture, selectedMessageId);
    await page.mouse.wheel(0, -320);
    await settleFrames(page, 3);

    const before = await waitForStableTranscriptScrollSnapshot(page);
    expect(before.nearBottom).toBe(false);
    expect(
      before.visibleRows.some((row) => row.messageId === selectedMessageId),
    ).toBe(true);

    await selectTextInMessage(page, selectedMessageId);
    await waitForProtectedRows(page, 0);
    await settleFrames(page, 4);

    const after = await waitForStableTranscriptScrollSnapshot(page);
    expect(after.nearBottom).toBe(false);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(
      MAX_SCROLLBACK_SELECTION_SCROLL_DRIFT_PX,
    );
    expect(
      after.visibleRows.some((row) => row.messageId === selectedMessageId),
    ).toBe(true);
  });

  test("user message interactions above a huge assistant answer do not jump to latest", async ({
    page,
  }) => {
    test.skip(
      !requiresRealRenderer,
      "copy actions require the production React transcript renderer",
    );

    const fixture = buildCompletedHugeAssistantFixture();
    const userMessageId = "huge-user-0000";

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await scrollToMessage(page, fixture, userMessageId);
    await settleFrames(page, 4);

    const beforeClick = await collectTranscriptScrollSnapshot(page);
    expect(beforeClick.nearBottom).toBe(false);
    expect(
      beforeClick.visibleRows.some((row) => row.messageId === userMessageId),
    ).toBe(true);

    await page
      .locator(`[data-transcript-message-id="${userMessageId}"]`)
      .first()
      .click();
    await settleFrames(page, 4);

    const afterBubbleClick = await collectTranscriptScrollSnapshot(page);
    expect(afterBubbleClick.nearBottom).toBe(false);
    expect(
      Math.abs(afterBubbleClick.scrollTop - beforeClick.scrollTop),
    ).toBeLessThanOrEqual(4);
    expect(
      afterBubbleClick.visibleRows.some(
        (row) => row.messageId === userMessageId,
      ),
    ).toBe(true);

    await clickMessageCopyButton(page, userMessageId);

    const afterCopyClick = await collectTranscriptScrollSnapshot(page);
    expect(afterCopyClick.nearBottom).toBe(false);
    expect(
      Math.abs(afterCopyClick.scrollTop - afterBubbleClick.scrollTop),
    ).toBeLessThanOrEqual(24);
    expect(
      afterCopyClick.visibleRows.some((row) => row.messageId === userMessageId),
    ).toBe(true);
  });

  test("selected-text menu overlay protection cleans up after close", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("long-10k");
    const selectedMessageId = "long-09999";

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    await setSelectedTextMenuOpen(page, selectedMessageId, true);
    await waitForProtectedRows(page, 1);
    await expect(
      page.locator(`[data-virtual-row-id="message:${selectedMessageId}"]`),
    ).toHaveAttribute("data-virtual-row-protected", "true");

    await setSelectedTextMenuOpen(page, selectedMessageId, false);
    await waitForProtectedRows(page, 0);
  });

  test("MCP keepalive protects active rows, caps pressure, and clears on reset", async ({
    page,
  }) => {
    const fixture = buildTranscriptFixture("mcp-dynamic-rows");

    await loadTranscriptRenderer(page, {
      rendererUrl,
      rendererMode: "virtual",
      fixture,
    });

    const protectedMessageIds = [
      "mcp-message-025",
      "mcp-message-026",
      "mcp-message-027",
      "mcp-message-028",
      "mcp-message-029",
      "mcp-message-030",
    ];
    await scrollToMessage(page, fixture, "mcp-message-030");
    await applyHarnessOperation(page, {
      kind: "mcpFocus",
      atMs: 0,
      messageId: "mcp-message-030",
    });
    await applyHarnessOperation(page, {
      kind: "mcpOverlay",
      atMs: 0,
      messageId: "mcp-message-029",
    });
    await applyHarnessOperation(page, {
      kind: "mcpHostWork",
      atMs: 0,
      messageId: "mcp-message-028",
    });
    await applyHarnessOperation(page, {
      kind: "mcpNestedToolWork",
      atMs: 0,
      messageId: "mcp-message-027",
    });
    await applyHarnessOperation(page, {
      kind: "mcpRecentMessage",
      atMs: 0,
      messageId: "mcp-message-026",
    });
    await applyHarnessOperation(page, {
      kind: "mcpRecentResize",
      atMs: 0,
      messageId: "mcp-message-025",
    });

    await waitForProtectedRows(page, protectedMessageIds.length);
    await scrollToMessage(page, fixture, "mcp-message-000");

    for (const messageId of protectedMessageIds) {
      const row = page.locator(await messageRowSelector(page, messageId));
      await expect(row).toHaveAttribute("data-virtual-row-protected", "true");
      await expect(row).toHaveAttribute("data-virtual-row-visible", "false");
    }

    await waitForVirtualDiagnostics(page, {
      protectedRows: protectedMessageIds.length,
    });
    let diagnostics = await collectHarnessDiagnostics(page);
    expect(diagnostics).toMatchObject({
      forcedProtectedRowCount: 2,
      blankViewportPixels: 0,
    });
    const mcpCandidateCount = Number(diagnostics.mcpCandidateCount);
    const mcpProtectedRowCount = Number(diagnostics.mcpProtectedRowCount);
    const protectedRows = Number(diagnostics.protectedRows);
    expect(mcpCandidateCount).toBeGreaterThanOrEqual(4);
    expect(mcpCandidateCount).toBeLessThanOrEqual(
      DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY.mcpRowsPerSessionCap,
    );
    expect(mcpProtectedRowCount).toBe(mcpCandidateCount);
    expect(protectedRows).toBe(2 + mcpProtectedRowCount);
    expect(diagnostics.protectedOffscreenRows).toBe(protectedRows);

    await applyHarnessOperation(page, {
      kind: "mcpClearProtections",
      atMs: 0,
    });
    await waitForProtectedRows(page, 0);

    for (let index = 0; index < 12; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await applyHarnessOperation(page, {
        kind: "mcpHostWork",
        atMs: 0,
        messageId: `mcp-message-${suffix}`,
        sourceId: `mcp-cap-pressure-${suffix}`,
        nowMs: index + 1,
      });
    }

    await waitForVirtualDiagnostics(page, {
      mcpCandidateCount: 12,
      mcpProtectedRowCount: 8,
      evictedMcpRowCount: 4,
      protectedRows: 8,
    });
    diagnostics = await collectHarnessDiagnostics(page);
    expect(diagnostics).toMatchObject({
      mcpCandidateCount: 12,
      mcpProtectedRowCount: 8,
      evictedMcpRowCount: 4,
      protectedRows: 8,
      blankViewportPixels: 0,
    });
    await expect(
      page.locator(await messageRowSelector(page, "mcp-message-000")),
    ).toHaveAttribute("data-virtual-row-protected", "false");
    await expect(
      page.locator(await messageRowSelector(page, "mcp-message-011")),
    ).toHaveAttribute("data-virtual-row-protected", "true");

    await applyHarnessOperation(page, {
      kind: "mcpClearProtections",
      atMs: 0,
    });
    await waitForProtectedRows(page, 0);
  });
});
