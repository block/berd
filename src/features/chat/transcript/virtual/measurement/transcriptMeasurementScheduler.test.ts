import { describe, expect, it } from "vitest";
import {
  VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
} from "../../measurement/transcriptLayoutPending";
import type { TranscriptRowDescriptor } from "../../projection/transcriptItemTypes";
import type { TranscriptVirtualMeasurementToken } from "../transcriptVirtualTypes";
import {
  createTranscriptMeasurementScheduler,
  type TranscriptMeasurementControllerTarget,
} from "./index";

const SESSION_ID = "session-a";
const WIDTH_SCOPE = "w:720";

describe("TranscriptMeasurementScheduler", () => {
  it("drops stale sessionEpoch measurements before cache or controller updates", () => {
    const scheduler = createScheduler([row("row-1", 120)]);
    const token = tokenFor(scheduler, "row-1");

    const result = scheduler.recordMountedMeasurement({
      token: { ...token, sessionEpoch: 0 },
      measuredBlockSize: 160,
    });

    expect(result).toMatchObject({
      status: "dropped",
      reason: "stale-token",
      queuedControllerUpdate: false,
    });
    expect(scheduler.getCachedMeasurement("row-1")).toBeNull();
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
    expect(scheduler.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 1,
      staleMeasurementEpochDrops: 1,
      mountedMeasurementsAccepted: 0,
    });
  });

  it("drops stale heightRevision results after row descriptors update", () => {
    const scheduler = createScheduler([
      row("row-1", 120, { heightRevision: "height:old" }),
    ]);
    const staleToken = tokenFor(scheduler, "row-1");

    scheduler.setRows([row("row-1", 120, { heightRevision: "height:new" })]);

    const result = scheduler.recordOffscreenMeasurement({
      token: staleToken,
      height: 180,
      source: "offscreen-real",
    });

    expect(result).toMatchObject({
      status: "dropped",
      reason: "stale-token",
    });
    expect(scheduler.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 1,
      staleMeasurementRevisionDrops: 1,
      offscreenRealMeasurementsAccepted: 0,
    });
  });

  it("keeps cache entries width scoped and rejects old-width results", () => {
    const scheduler = createScheduler([row("row-1", 120)]);
    const controller = new RecordingController();
    const token = tokenFor(scheduler, "row-1");

    expect(
      scheduler.recordOffscreenMeasurement({
        token,
        height: 180,
        source: "offscreen-real",
      }).status,
    ).toBe("accepted");
    expect(scheduler.flushControllerUpdateBatch(controller)).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
    expect(scheduler.getCachedMeasurement("row-1")).toMatchObject({
      height: 180,
      source: "offscreen-real",
    });

    scheduler.setContext({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: "w:480",
    });

    expect(scheduler.getCachedMeasurement("row-1")).toBeNull();
    expect(
      scheduler.recordMountedMeasurement({
        token,
        measuredBlockSize: 220,
      }),
    ).toMatchObject({
      status: "dropped",
      reason: "stale-token",
    });

    const compactToken = tokenFor(scheduler, "row-1");
    expect(
      scheduler.recordMountedMeasurement({
        token: compactToken,
        measuredBlockSize: 220,
      }).status,
    ).toBe("accepted");
    expect(scheduler.getCachedMeasurement("row-1")).toMatchObject({
      height: 220,
      source: "visible",
    });

    scheduler.setContext({
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: WIDTH_SCOPE,
    });

    expect(scheduler.getCachedMeasurement("row-1")).toMatchObject({
      height: 180,
      source: "offscreen-real",
    });
    expect(scheduler.getDiagnostics()).toMatchObject({
      staleMeasurementWidthDrops: 1,
    });
  });

  it("routes shell rows to shell measurement and keeps estimate-only rows offscreen-free", () => {
    const scheduler = createScheduler([
      row("shell-row", 180, {
        measurementPolicy: "measure-shell",
        capabilities: capabilities({
          canOffscreenRenderReal: false,
          canOffscreenRenderShell: true,
          hasMcpApp: true,
        }),
      }),
      row("estimate-row", 240, {
        measurementPolicy: "estimate-only",
        capabilities: capabilities({
          canOffscreenRenderReal: false,
          canOffscreenRenderShell: false,
          hasActiveTimer: true,
        }),
      }),
    ]);

    expect(scheduler.planOffscreenMeasurement("shell-row")).toMatchObject({
      kind: "offscreen-shell",
      estimatedHeight: 180,
      cachedHeight: null,
    });
    expect(
      scheduler.recordOffscreenMeasurement({
        token: tokenFor(scheduler, "shell-row"),
        height: 260,
        source: "offscreen-shell",
      }),
    ).toMatchObject({
      status: "accepted",
      queuedControllerUpdate: false,
      entry: {
        height: 260,
        source: "estimate",
        finalized: false,
      },
    });
    expect(scheduler.getCachedMeasurement("shell-row")).toMatchObject({
      height: 260,
      source: "estimate",
      finalized: false,
    });
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
    expect(
      scheduler.recordOffscreenMeasurement({
        token: tokenFor(scheduler, "shell-row"),
        height: 260,
        source: "offscreen-real",
      }),
    ).toMatchObject({
      status: "dropped",
      reason: "policy-blocked",
    });

    expect(scheduler.planOffscreenMeasurement("estimate-row")).toMatchObject({
      kind: "estimate-only",
      estimatedHeight: 240,
    });
    expect(
      scheduler.recordOffscreenMeasurement({
        token: tokenFor(scheduler, "estimate-row"),
        height: 240,
        source: "offscreen-shell",
      }),
    ).toMatchObject({
      status: "dropped",
      reason: "policy-blocked",
    });
    expect(scheduler.getDiagnostics()).toMatchObject({
      offscreenShellMeasurementsAccepted: 0,
      estimateOnlyPlans: 1,
      policyMeasurementsDropped: 2,
    });
  });

  it("keeps visible measurements authoritative over later shell measurements", () => {
    const scheduler = createScheduler([
      row("shell-row", 180, {
        measurementPolicy: "measure-shell",
        capabilities: capabilities({
          canOffscreenRenderReal: false,
          canOffscreenRenderShell: true,
        }),
      }),
    ]);
    const controller = new RecordingController();
    const token = tokenFor(scheduler, "shell-row");

    expect(
      scheduler.recordMountedMeasurement({
        token,
        measuredBlockSize: 260,
      }),
    ).toMatchObject({
      status: "accepted",
      queuedControllerUpdate: true,
    });
    expect(scheduler.flushControllerUpdateBatch(controller)).toMatchObject({
      accepted: 1,
      rejected: 0,
    });

    expect(
      scheduler.recordOffscreenMeasurement({
        token,
        height: 180,
        source: "offscreen-shell",
      }),
    ).toMatchObject({
      status: "accepted",
      queuedControllerUpdate: false,
    });
    expect(scheduler.getCachedMeasurement("shell-row")).toMatchObject({
      height: 260,
      source: "visible",
    });
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
    expect(scheduler.getDiagnostics()).toMatchObject({
      mountedMeasurementsAccepted: 1,
      offscreenShellMeasurementsAccepted: 0,
    });
  });

  it("defers mounted measurement while layout-pending markers exist and finalizes after they clear", () => {
    const scheduler = createScheduler([row("row-1", 120)]);
    const controller = new RecordingController();
    const token = tokenFor(scheduler, "row-1");
    const root = document.createElement("div");
    root.setAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE, "image-loading");
    root.setAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE, "320");

    const pending = scheduler.recordMountedMeasurement({
      token,
      measuredBlockSize: 12,
      root,
    });

    expect(pending).toMatchObject({
      status: "pending",
      blockSize: 320,
      source: "reserved",
      queuedControllerUpdate: false,
    });
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingMeasurements: 1,
      pendingMeasurementsCreated: 1,
    });

    root.removeAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE);
    root.removeAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE);

    const finalized = scheduler.finalizePendingMeasurement({
      token,
      measuredBlockSize: 360,
      root,
    });

    expect(finalized).toMatchObject({
      status: "accepted",
      queuedControllerUpdate: true,
    });
    expect(scheduler.getCachedMeasurement("row-1")).toMatchObject({
      height: 360,
      source: "visible",
      finalized: true,
    });
    expect(scheduler.flushControllerUpdateBatch(controller)).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
    expect(controller.updates).toMatchObject([{ height: 360 }]);
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingMeasurements: 0,
      pendingMeasurementsFinalized: 1,
      mountedMeasurementsAccepted: 1,
    });
  });

  it("removes pending mounted measurements when their row revision becomes stale", () => {
    const scheduler = createScheduler([
      row("row-1", 120, { heightRevision: "height:old" }),
    ]);
    const token = tokenFor(scheduler, "row-1");
    const root = document.createElement("div");
    root.setAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE, "image-loading");

    expect(
      scheduler.recordMountedMeasurement({
        token,
        measuredBlockSize: 160,
        root,
      }),
    ).toMatchObject({
      status: "pending",
    });
    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingMeasurements: 1,
    });

    scheduler.setRows([row("row-1", 120, { heightRevision: "height:new" })]);

    expect(scheduler.getDiagnostics()).toMatchObject({
      pendingMeasurements: 0,
    });
    expect(
      scheduler.finalizePendingMeasurement({
        token,
        measuredBlockSize: 180,
        root,
      }),
    ).toMatchObject({
      status: "dropped",
      reason: "stale-token",
    });
  });

  it("coalesces queued controller updates by exact measurement key", () => {
    let batchNotifications = 0;
    const scheduler = createScheduler([row("row-1", 120)], {
      onControllerBatchQueued: () => {
        batchNotifications += 1;
      },
    });
    const controller = new RecordingController();
    const token = tokenFor(scheduler, "row-1");

    scheduler.recordMountedMeasurement({ token, measuredBlockSize: 140 });
    scheduler.recordMountedMeasurement({ token, measuredBlockSize: 180 });

    const flushed = scheduler.flushControllerUpdateBatch(controller);

    expect(batchNotifications).toBe(1);
    expect(flushed).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
    expect(flushed.updates).toHaveLength(1);
    expect(flushed.updates[0]).toMatchObject({
      height: 180,
      source: "visible",
    });
    expect(controller.updates).toMatchObject([{ height: 180 }]);
    expect(scheduler.getDiagnostics()).toMatchObject({
      controllerUpdatesQueued: 2,
      controllerUpdateBatches: 1,
      controllerUpdatesFlushed: 1,
      controllerUpdatesAccepted: 1,
    });
  });

  it("queues cached measurements back to a recreated controller with current tokens", () => {
    const scheduler = createScheduler([row("row-1", 120)]);
    const firstController = new RecordingController();
    const token = tokenFor(scheduler, "row-1");

    scheduler.recordMountedMeasurement({ token, measuredBlockSize: 172 });
    expect(scheduler.flushControllerUpdateBatch(firstController)).toMatchObject(
      {
        accepted: 1,
      },
    );

    const recreatedController = new RecordingController();
    expect(scheduler.queueCachedControllerUpdate("row-1")).toBe(true);
    expect(
      scheduler.flushControllerUpdateBatch(recreatedController),
    ).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
    expect(recreatedController.updates).toMatchObject([{ height: 172 }]);

    scheduler.setRows([row("row-1", 120, { heightRevision: "height:new" })]);

    expect(scheduler.peekCachedMeasurement("row-1")).toBeNull();
    expect(scheduler.queueCachedControllerUpdate("row-1")).toBe(false);
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
  });

  it("does not queue non-finalized shell estimates back to a recreated controller", () => {
    const scheduler = createScheduler([
      row("shell-row", 120, {
        measurementPolicy: "measure-shell",
        capabilities: capabilities({
          canOffscreenRenderReal: false,
          canOffscreenRenderShell: true,
        }),
      }),
    ]);

    expect(
      scheduler.recordOffscreenMeasurement({
        token: tokenFor(scheduler, "shell-row"),
        height: 172,
        source: "offscreen-shell",
      }),
    ).toMatchObject({
      status: "accepted",
      queuedControllerUpdate: false,
      entry: {
        source: "estimate",
        finalized: false,
      },
    });

    expect(scheduler.queueCachedControllerUpdate("shell-row")).toBe(false);
    expect(scheduler.drainControllerUpdateBatch()).toEqual([]);
  });
});

function createScheduler(
  rows: readonly TranscriptRowDescriptor[],
  options: Parameters<typeof createTranscriptMeasurementScheduler>[1] = {},
) {
  return createTranscriptMeasurementScheduler(
    {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: WIDTH_SCOPE,
      rows,
    },
    options,
  );
}

function tokenFor(
  scheduler: ReturnType<typeof createScheduler>,
  rowId: string,
): TranscriptVirtualMeasurementToken {
  const token = scheduler.getMeasurementToken(rowId);
  expect(token).not.toBeNull();
  return token as TranscriptVirtualMeasurementToken;
}

function row(
  rowId: string,
  estimatedHeight: number,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: overrides.kind ?? "message",
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
    capabilities: overrides.capabilities ?? capabilities(),
    measurementSafetyReasons: overrides.measurementSafetyReasons ?? [],
    keepAlivePriority: overrides.keepAlivePriority ?? "none",
  };
}

function capabilities(
  overrides: Partial<TranscriptRowDescriptor["capabilities"]> = {},
): TranscriptRowDescriptor["capabilities"] {
  return {
    stateful: false,
    hasMcpApp: false,
    hasHostCalls: false,
    hasHostActionHandlers: false,
    hasActiveTimer: false,
    hasActiveToolWork: false,
    hasActiveMcpHostRequest: false,
    hasActiveNestedToolRequest: false,
    hasDynamicAsyncLayout: false,
    hasPendingLayout: false,
    hasFocusedDescendant: false,
    hasOpenOverlay: false,
    hasOpenMenu: false,
    hasOpenDialog: false,
    hasOpenPopover: false,
    hasOpenLightbox: false,
    hasCopyFeedback: false,
    hasImageContent: false,
    hasToolContent: false,
    hasReasoningContent: false,
    hasActionRequired: false,
    hasStreamingContent: false,
    hasUnknownUnsafeDescendants: false,
    protectsSelection: false,
    canOffscreenRenderReal: true,
    canOffscreenRenderShell: true,
    ...overrides,
  };
}

class RecordingController implements TranscriptMeasurementControllerTarget {
  readonly updates: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }[] = [];

  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }) {
    this.updates.push(input);
    return {
      accepted: true,
      correction: null,
    };
  }
}
