import { describe, expect, it } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  createTranscriptTanStackVirtualAdapter,
  createTranscriptVirtualController,
} from "./index";
import type { TranscriptVirtualMeasurementToken } from "./transcriptVirtualTypes";

const SESSION_ID = "session-a";
const WIDTH_SCOPE = "w:720";

type EngineUnderTest =
  | ReturnType<typeof createTranscriptVirtualController>
  | ReturnType<typeof createTranscriptTanStackVirtualAdapter>;

describe("streaming transcript height jitter validation", () => {
  for (const { name, createEngine } of [
    {
      name: "controller",
      createEngine: () => createController(),
    },
    {
      name: "tanstack adapter",
      createEngine: () => createAdapter(),
    },
  ]) {
    it(`${name} keeps an active streaming row size monotonic across revisions and measurements`, () => {
      const engine = createEngine();

      engine.setRows([
        row("intro", 100),
        row("assistant-tail", 140, {
          anchorPriority: "streaming",
          heightRevision: "tail:1",
        }),
      ]);

      expect(streamingRowSize(engine)).toBe(140);

      expect(
        engine.applyMeasuredHeight({
          token: tokenFor(engine, "assistant-tail"),
          height: 420,
        }).accepted,
      ).toBe(true);
      expect(streamingRowSize(engine)).toBe(420);
      expect(engine.getState().virtualScrollHeight).toBe(520);

      engine.setRows([
        row("intro", 100),
        row("assistant-tail", 180, {
          anchorPriority: "streaming",
          heightRevision: "tail:2",
        }),
      ]);

      expect(
        streamingRowSize(engine),
        "a new streaming heightRevision should not fall back below the previous measured row height",
      ).toBe(420);
      expect(engine.getState().virtualScrollHeight).toBe(520);

      expect(
        engine.applyMeasuredHeight({
          token: tokenFor(engine, "assistant-tail"),
          height: 260,
        }).accepted,
      ).toBe(true);
      expect(
        streamingRowSize(engine),
        "a smaller pending Streamdown measurement should be accepted without shrinking the active row",
      ).toBe(420);
      expect(engine.getState().virtualScrollHeight).toBe(520);

      expect(
        engine.applyMeasuredHeight({
          token: tokenFor(engine, "assistant-tail"),
          height: 560,
        }).accepted,
      ).toBe(true);
      expect(streamingRowSize(engine)).toBe(560);
      expect(engine.getState().virtualScrollHeight).toBe(660);
    });
  }
});

function createController() {
  return createTranscriptVirtualController({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    widthScope: WIDTH_SCOPE,
    viewportHeight: 300,
    footerHeight: 0,
    scrollTop: 0,
  });
}

function createAdapter() {
  return createTranscriptTanStackVirtualAdapter({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    widthScope: WIDTH_SCOPE,
    viewportHeight: 300,
    footerHeight: 0,
    scrollTop: 0,
  });
}

function tokenFor(
  engine: EngineUnderTest,
  rowId: string,
): TranscriptVirtualMeasurementToken {
  const token = engine.getMeasurementToken(rowId);
  expect(token).not.toBeNull();
  return token as TranscriptVirtualMeasurementToken;
}

function streamingRowSize(engine: EngineUnderTest): number {
  const item = engine
    .getRange()
    .virtualItems.find((current) => current.row.rowId === "assistant-tail");
  expect(item).toBeDefined();
  return item?.size ?? 0;
}

function row(
  rowId: string,
  estimatedHeight: number,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId,
    blockIds: [rowId],
    renderRevision: overrides.renderRevision ?? `render:${rowId}`,
    heightRevision:
      overrides.heightRevision ?? `height:${rowId}:${estimatedHeight}`,
    layoutRevision: overrides.layoutRevision ?? "layout-spacing:0",
    estimatedHeight,
    spacingBefore: overrides.spacingBefore ?? 0,
    anchorPriority: overrides.anchorPriority ?? "stable",
    measurementPolicy: overrides.measurementPolicy ?? "measure-real",
    layoutPendingPolicy: overrides.layoutPendingPolicy ?? "can-finalize",
    capabilities: overrides.capabilities ?? {
      stateful: false,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: overrides.keepAlivePriority ?? "none",
    fragment: overrides.fragment ?? {
      fragmentId: rowId,
      fragmentIndex: 0,
      fragmentCount: 1,
      role: "single",
      content: [],
      isStreamingTail: overrides.anchorPriority === "streaming",
      messageScrollTarget: true,
      isCodeContinuationChunk: false,
      startsWithHeading: false,
    },
    ...overrides,
  };
}
