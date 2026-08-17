import { describe, expect, it } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  TranscriptScrollCoordinationAuthority,
  type TranscriptScrollCoordinationEngine,
} from "./transcriptScrollCoordinationAuthority";
import { createTranscriptVirtualController } from "./transcriptVirtualController";
import type {
  TranscriptScrollAnchor,
  TranscriptScrollOperation,
  TranscriptSessionGeometry,
  TranscriptVirtualMeasurementToken,
} from "./transcriptVirtualTypes";

const SESSION_ID = "session-authority";
const WIDTH_SCOPE = "w:720";

function createEngine(
  overrides: Partial<TranscriptSessionGeometry> = {},
): TranscriptScrollCoordinationEngine {
  return createTranscriptVirtualController({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    widthScope: WIDTH_SCOPE,
    viewportHeight: 300,
    footerHeight: 0,
    scrollTop: 0,
    ...overrides,
  });
}

function op(
  generation: number,
  cause: TranscriptScrollOperation["cause"] = "target",
): TranscriptScrollOperation {
  return { generation, cause };
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
    renderRevision: `render:${rowId}`,
    heightRevision: `height:${rowId}:${estimatedHeight}`,
    layoutRevision: "layout-spacing:0",
    estimatedHeight,
    spacingBefore: 0,
    anchorPriority: "stable",
    measurementPolicy: "measure-real",
    layoutPendingPolicy: "can-finalize",
    capabilities: {
      stateful: false,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: "none",
    ...overrides,
  };
}

describe("TranscriptScrollCoordinationAuthority", () => {
  it("keeps the streaming height floor monotonic across a revision bump", () => {
    const engine = createEngine();
    const authority = new TranscriptScrollCoordinationAuthority(engine);

    authority.setRows([
      row("intro", 100),
      row("tail", 140, { anchorPriority: "streaming", heightRevision: "t:1" }),
    ]);

    const tailToken = () =>
      authority.getMeasurementToken(
        "tail",
      ) as TranscriptVirtualMeasurementToken;
    const tailSize = () =>
      authority
        .getRange()
        .virtualItems.find((item) => item.row.rowId === "tail")?.size ?? 0;

    authority.applyMeasuredHeight({ token: tailToken(), height: 420 });
    expect(tailSize()).toBe(420);

    authority.setRows([
      row("intro", 100),
      row("tail", 180, { anchorPriority: "streaming", heightRevision: "t:2" }),
    ]);
    expect(
      tailSize(),
      "a new heightRevision must not fall back below the previous measured height",
    ).toBe(420);

    authority.applyMeasuredHeight({ token: tailToken(), height: 260 });
    expect(
      tailSize(),
      "a smaller pending measurement must not shrink the active streaming row",
    ).toBe(420);
  });

  it("targets the authority-supplied row anchor on detached resize, discriminating against engine drift", () => {
    const engine = createEngine({ viewportHeight: 200 });
    const authority = new TranscriptScrollCoordinationAuthority(engine);

    authority.setRows([
      row("a", 100),
      row("b", 100),
      row("c", 100),
      row("d", 100),
    ]);

    const proposed: TranscriptScrollAnchor = {
      type: "row",
      rowId: "b",
      offsetWithinRow: 5,
      anchorRevision: "unused",
    };
    const proposal = authority.proposeAnchor(proposed, op(1));
    expect(proposal?.nextScrollTop).toBe(105);
    // Confirm the browser applied the proposed write.
    engine.syncViewport(
      {
        scrollTop: 105,
        viewportHeight: 200,
        footerHeight: 0,
        widthScope: WIDTH_SCOPE,
      },
      { source: "correction" },
    );
    expect(engine.getState().anchor).toEqual({
      type: "row",
      rowId: "b",
      offsetWithinRow: 5,
      anchorRevision: "height:b:100",
    });

    // "a" grows and "b" gets remeasured (a fresh heightRevision), forcing the
    // wrapped engine to autonomously recapture its own anchor away from "b".
    authority.setRows([
      row("a", 500),
      row("b", 100, { heightRevision: "height:b:2" }),
      row("c", 100),
      row("d", 100),
    ]);
    expect(
      engine.getState().anchor,
      "the wrapped engine's own stale-anchor recapture should drift off the authority's tracked row",
    ).toEqual({
      type: "row",
      rowId: "a",
      offsetWithinRow: 105,
      anchorRevision: "height:a:500",
    });

    const correction = authority.reconcileResize({
      scrollTop: 105,
      viewportHeight: 400,
      footerHeight: 0,
      widthScope: WIDTH_SCOPE,
    });

    // If the authority's explicit re-target were removed, this would remain
    // the drifted "a" anchor from the recapture above instead of "b".
    expect(engine.getState().anchor).toEqual({
      type: "row",
      rowId: "b",
      offsetWithinRow: 5,
      anchorRevision: "height:b:2",
    });
    expect(correction?.nextScrollTop).toBe(400);
  });

  it("discriminates same/older/newer/no-operation acknowledgement", () => {
    const engine = createEngine();
    const authority = new TranscriptScrollCoordinationAuthority(engine);
    authority.setRows([row("a", 100), row("b", 100)]);

    authority.proposeAnchor({ type: "bottom" }, op(2));
    expect(authority.getPendingOperation()).toEqual(op(2));

    expect(authority.acknowledge(op(1))).toBe(false);
    expect(
      authority.getPendingOperation(),
      "an older acknowledgement must not clear a newer pending operation",
    ).toEqual(op(2));

    expect(authority.acknowledge(op(2))).toBe(true);
    expect(
      authority.getPendingOperation(),
      "a matching acknowledgement retires the pending operation",
    ).toBeNull();

    expect(
      authority.acknowledge(op(2)),
      "acknowledging with no pending operation is a no-op",
    ).toBe(false);

    authority.proposeAnchor({ type: "bottom" }, op(3));
    expect(
      authority.acknowledge(op(5)),
      "an unmatched newer acknowledgement must not supersede pending - only a proposal can",
    ).toBe(false);
    expect(authority.getPendingOperation()).toEqual(op(3));
  });

  it("requires an explicit anchor on reset and never installs an untagged bottom correction", () => {
    const geometry: TranscriptSessionGeometry = {
      sessionId: "session-2",
      sessionEpoch: 2,
      widthScope: WIDTH_SCOPE,
      viewportHeight: 300,
      footerHeight: 0,
      scrollTop: 400,
    };

    const bareEngine = createEngine();
    bareEngine.reset(geometry);
    expect(
      bareEngine.getState().anchor,
      "the raw engine's own reset autonomously installs a bottom anchor",
    ).toEqual({ type: "bottom" });

    const engine = createEngine();
    const authority = new TranscriptScrollCoordinationAuthority(engine);
    const anchor: TranscriptScrollAnchor = {
      type: "row",
      rowId: "not-loaded-yet",
      offsetWithinRow: 0,
      anchorRevision: "unused",
    };
    const operation = op(7, "target");
    const correction = authority.reset(geometry, anchor, operation);

    expect(
      engine.getState().anchor,
      "the authority must own reset and install the supplied anchor, not an autonomous bottom",
    ).toEqual({
      type: "row",
      rowId: "not-loaded-yet",
      offsetWithinRow: 0,
      anchorRevision: "",
    });
    if (correction) {
      expect(correction.operation).toEqual(operation);
    }
  });

  it("retires operation identity on acknowledgement and on supersession", () => {
    const engine = createEngine();
    const authority = new TranscriptScrollCoordinationAuthority(engine);
    authority.setRows([row("a", 100), row("b", 100)]);

    authority.proposeAnchor({ type: "bottom" }, op(1));
    authority.acknowledge(op(1));
    expect(authority.getPendingOperation()).toBeNull();

    // A later, unrelated reflow must not be tagged with the retired operation.
    const reflow = authority.setRows([row("a", 100), row("b", 260)]);
    expect(reflow.correction?.operation).toBeUndefined();

    authority.proposeAnchor({ type: "bottom" }, op(2));
    authority.proposeAnchor({ type: "bottom" }, op(3));
    expect(
      authority.acknowledge(op(2)),
      "generation 2 was retired by supersession from generation 3 and can no longer be acknowledged",
    ).toBe(false);
    expect(authority.getPendingOperation()).toEqual(op(3));
  });

  it("treats raw overscroll past the modeled bottom as observation only", () => {
    const engine = createEngine();
    const authority = new TranscriptScrollCoordinationAuthority(engine);
    authority.setRows([row("a", 100), row("b", 100)]);

    const before = engine.getState();
    expect(before.bottomScrollTop).toBe(0);

    const result = authority.observeScroll({
      scrollTop: before.bottomScrollTop + 500,
      viewportHeight: 300,
      footerHeight: 0,
      widthScope: WIDTH_SCOPE,
    });

    expect(result.correction).toBeNull();
    const after = engine.getState();
    expect(after.anchor).toEqual(before.anchor);
    expect(after.pinnedToBottom).toBe(before.pinnedToBottom);
    expect(after.scrollTop).toBe(before.scrollTop);
    expect(authority.getPendingScrollCorrection()).toBeNull();
  });
});
