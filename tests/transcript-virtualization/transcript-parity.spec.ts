import { expect, test } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptHarnessOperation,
  type TranscriptFixtureName,
  type TranscriptRendererMode,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import {
  formatTranscriptDiagnosticsValidationErrors,
  validateTranscriptDiagnostics,
  type TranscriptDiagnostics,
} from "../../src/features/chat/transcript/diagnostics";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import {
  runTranscriptRendererHarness,
  type TranscriptOperationEvidence,
  type TranscriptRendererRunResult,
  type TranscriptScrollSnapshot,
  type TranscriptVisibleRowSnapshot,
} from "./harness/rendererHarness";
import {
  DOM_BOUNDED_FULL_HISTORY_THRESHOLDS,
  getRealBridgeProofMcpRowChromeTolerancePx,
  isRealBridgeProofMetricClassified,
  isRealBridgeProofRun,
  type RealBridgeProofMetricClassification,
} from "./harness/thresholds";
import { transcriptTimingSampleOverlapsExclusionWindow } from "./harness/operationTiming";

const DEFAULT_SCENARIOS: TranscriptFixtureName[] = [
  "long-10k",
  "huge-assistant-output",
  "tool-chain-storm",
  "mcp-dynamic-rows",
  "dynamic-media-code",
  "composer-growth-session-switch",
  "pr928-fragment-tail",
];
const DEFAULT_RENDERER_MODES: TranscriptRendererMode[] = ["legacy", "virtual"];
const HOSTED_GHA_HUGE_OUTPUT_TAIL_THRESHOLD_MS = 2_000;

function getTimeToFirstVisibleTailThresholdMs(
  fixture: ReturnType<typeof buildTranscriptFixture>,
  rendererMode: TranscriptRendererMode,
): number {
  // macOS hosted runners have shown isolated browser scheduling stalls for
  // this intentionally huge fixture. Keep the product budget at 1,200 ms and
  // scope this temporary CI-only headroom to the one affected assertion.
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    rendererMode === "virtual" &&
    fixture.name === "huge-assistant-output"
  ) {
    return HOSTED_GHA_HUGE_OUTPUT_TAIL_THRESHOLD_MS;
  }

  return DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.timeToFirstVisibleTailMs;
}

function parseList<T extends string>(
  rawValue: string | undefined,
  fallback: readonly T[],
): T[] {
  if (!rawValue) {
    return [...fallback];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is T => value.length > 0);
}

function requireDiagnostics(diagnostics: Record<string, unknown>) {
  const validation = validateTranscriptDiagnostics(diagnostics);
  expect(
    validation.errors,
    formatTranscriptDiagnosticsValidationErrors(validation.errors),
  ).toEqual([]);
  return validation.diagnostics;
}

function requireProductionDiagnostics(
  diagnostics: Record<string, unknown> | null,
) {
  if (diagnostics == null) {
    return null;
  }

  return requireDiagnostics(diagnostics);
}

function hasRealBridgeProofClassification(
  diagnostics: TranscriptDiagnostics,
  fixture: ReturnType<typeof buildTranscriptFixture>,
  classification: RealBridgeProofMetricClassification,
) {
  return isRealBridgeProofMetricClassified({
    bridgeKind: diagnostics.bridgeKind,
    fixtureName: fixture.name,
    classification,
  });
}

function getAllowedSessionStaleMeasurementDrops(
  fixture: ReturnType<typeof buildTranscriptFixture>,
): number {
  return fixture.operations.reduce((count, operation) => {
    if (operation.kind !== "switchSession") {
      return count;
    }
    return count + operation.pendingAsyncWork.length;
  }, 0);
}

function isRealProductionTimingProof(
  diagnostics: TranscriptDiagnostics,
  productionDiagnostics: TranscriptDiagnostics | null,
) {
  return (
    isRealBridgeProofRun(diagnostics.bridgeKind) &&
    productionDiagnostics?.bridgeKind === "production-virtual-message-timeline"
  );
}

function expectProductionTimingWithinThresholds(
  diagnostics: TranscriptDiagnostics,
  productionDiagnostics: TranscriptDiagnostics,
  result: TranscriptRendererRunResult,
  fixture: ReturnType<typeof buildTranscriptFixture>,
) {
  const reactCommitP95Ms =
    result.productionOperationTimingMetrics.reactCommitSampleCount > 0
      ? result.productionOperationTimingMetrics.reactCommitP95Ms
      : productionDiagnostics.reactCommitP95Ms;
  const scrollHandlerP95Ms =
    result.productionOperationTimingMetrics.scrollHandlerSampleCount > 0
      ? result.productionOperationTimingMetrics.scrollHandlerP95Ms
      : productionDiagnostics.scrollHandlerP95Ms;

  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "productionReactCommitAndScrollHandlerP95Ms",
    )
  ) {
    expect(
      reactCommitP95Ms,
      "production virtual timeline React commit p95 should exclude bridge wrapper commits",
    ).toBeLessThanOrEqual(DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.reactCommitP95Ms);
    expect(
      scrollHandlerP95Ms,
      "production virtual timeline scroll handler p95 should exclude bridge wrapper scroll listeners",
    ).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollHandlerP95Ms,
    );
  }
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "browserLongTasksAndDroppedFrames",
    )
  ) {
    expect(
      result.productionTimingMetrics.longTasksOver50Ms,
      "browser long tasks outside synchronous bridge fixture operations should stay within default-on budget",
    ).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.longTasksOver50Ms,
    );
    expect(
      result.productionTimingMetrics.droppedFrameRate,
      "dropped frame rate outside synchronous bridge fixture operations should stay within default-on budget",
    ).toBeLessThanOrEqual(DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.droppedFrameRate);
  }
}

function timingIntervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function overlapsBridgeTimingExclusionWindow(
  startTime: number,
  endTime: number,
  result: TranscriptRendererRunResult,
) {
  return result.bridgeTimingExclusionWindows.some((window) =>
    timingIntervalsOverlap(
      startTime,
      endTime,
      window.startTime,
      window.endTime,
    ),
  );
}

function expectProductionTimingExcludesBridgeFixtureWork(
  result: TranscriptRendererRunResult,
  fixture: ReturnType<typeof buildTranscriptFixture>,
) {
  expect(
    result.bridgeTimingExclusionWindows,
    "production timing proof should record one exclusion window per fixture operation",
  ).toHaveLength(fixture.operations.length);

  for (const [operationIndex, operation] of fixture.operations.entries()) {
    const window = result.bridgeTimingExclusionWindows[operationIndex];
    expect(
      window,
      `operation ${operationIndex} should have exclusion window`,
    ).toBeDefined();
    expect(window.reason).toBe(`fixture-operation:${operation.kind}`);
    expect(window.startTime).toBeGreaterThanOrEqual(result.metrics.startTime);
    expect(window.endTime).toBeLessThanOrEqual(result.metrics.endTime);
    expect(window.endTime).toBeGreaterThan(window.startTime);
  }

  expect(result.productionTimingMetrics.frameCount).toBeLessThanOrEqual(
    result.metrics.frameCount,
  );
  expect(result.productionTimingMetrics.longTasks.length).toBeLessThanOrEqual(
    result.metrics.longTasks.length,
  );

  const overlappingFrameIntervals =
    result.productionTimingMetrics.frameIntervals.filter((interval) =>
      overlapsBridgeTimingExclusionWindow(
        interval.startTime,
        interval.endTime,
        result,
      ),
    );
  expect(
    overlappingFrameIntervals,
    "production frame timing should exclude intervals overlapping bridge fixture operations",
  ).toEqual([]);

  const overlappingLongTasks = result.productionTimingMetrics.longTasks.filter(
    (task) =>
      overlapsBridgeTimingExclusionWindow(
        task.startTime,
        task.startTime + task.duration,
        result,
      ),
  );
  expect(
    overlappingLongTasks,
    "production long task timing should exclude tasks overlapping bridge fixture operations",
  ).toEqual([]);

  expect(
    result.productionOperationTimingMetrics.reactCommitSampleCount,
    "operation-scoped production React commit sample count should not increase after fixture-operation filtering",
  ).toBeLessThanOrEqual(result.operationTimingMetrics.reactCommitSampleCount);
  expect(
    result.productionOperationTimingMetrics.scrollHandlerSampleCount,
    "operation-scoped production scroll-handler sample count should not increase after fixture-operation filtering",
  ).toBeLessThanOrEqual(result.operationTimingMetrics.scrollHandlerSampleCount);

  const overlappingReactCommitSamples =
    result.productionOperationTimingMetrics.reactCommitSamples.filter(
      (sample) =>
        transcriptTimingSampleOverlapsExclusionWindow(
          sample,
          result.bridgeTimingExclusionWindows,
        ),
    );
  expect(
    overlappingReactCommitSamples,
    "operation-scoped React commit timing should exclude samples overlapping bridge fixture operations",
  ).toEqual([]);

  const overlappingScrollHandlerSamples =
    result.productionOperationTimingMetrics.scrollHandlerSamples.filter(
      (sample) =>
        transcriptTimingSampleOverlapsExclusionWindow(
          sample,
          result.bridgeTimingExclusionWindows,
        ),
    );
  expect(
    overlappingScrollHandlerSamples,
    "operation-scoped scroll-handler timing should exclude samples overlapping bridge fixture operations",
  ).toEqual([]);
}

function expectVirtualDiagnosticsWithinThresholds(
  diagnostics: TranscriptDiagnostics,
  result: TranscriptRendererRunResult,
  fixture: ReturnType<typeof buildTranscriptFixture>,
  rendererMode: TranscriptRendererMode,
) {
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "timeToFirstVisibleTailMs",
    )
  ) {
    expect(diagnostics.timeToFirstVisibleTailMs).toBeLessThanOrEqual(
      getTimeToFirstVisibleTailThresholdMs(fixture, rendererMode),
    );
  }
  expect(diagnostics.restoreReplayDrainMs).toBeLessThanOrEqual(
    DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.restoreReplayDrainMs,
  );
  if (
    !hasRealBridgeProofClassification(diagnostics, fixture, "projectionP95Ms")
  ) {
    expect(diagnostics.projectionP95Ms).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.projectionP95Ms,
    );
  }
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "descriptorChurnPercent",
    )
  ) {
    expect(diagnostics.descriptorChurnPercent).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.descriptorChurnPercent,
    );
  }
  expect(diagnostics.mountedRows).toBeLessThanOrEqual(
    Math.min(
      fixture.expectations.maxInitialMountedRows,
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.mountedRows,
    ),
  );
  if (
    !hasRealBridgeProofClassification(diagnostics, fixture, "protectedRows")
  ) {
    expect(diagnostics.protectedRows).toBeLessThanOrEqual(
      Math.min(
        fixture.expectations.maxProtectedRows,
        DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.protectedRows,
      ),
    );
  }
  expect(diagnostics.heapGrowthMb).toBeLessThanOrEqual(
    DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.heapGrowthMb,
  );
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "browserLongTasksAndDroppedFrames",
    ) &&
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "rawBrowserLongTasksAndDroppedFrames",
    )
  ) {
    expect(result.metrics.longTasksOver50Ms).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.longTasksOver50Ms,
    );
    expect(result.metrics.droppedFrameRate).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.droppedFrameRate,
    );
  }
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "reactCommitAndScrollHandlerP95Ms",
    )
  ) {
    expect(diagnostics.reactCommitP95Ms).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.reactCommitP95Ms,
    );
    expect(diagnostics.scrollHandlerP95Ms).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollHandlerP95Ms,
    );
  }
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "scrollCorrectionP95Px",
    )
  ) {
    expect(diagnostics.scrollCorrectionP95Px).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionP95Px,
    );
  }
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "scrollCorrectionsPerSecond",
    )
  ) {
    expect(diagnostics.scrollCorrectionsPerSecond).toBeLessThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionsPerSecond,
    );
  }
  expect(diagnostics.measurementBatchSize).toBeLessThanOrEqual(
    DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.measurementBatchSize,
  );
  const unexpectedStaleMeasurementDrops = Math.max(
    0,
    diagnostics.staleMeasurementDrops -
      getAllowedSessionStaleMeasurementDrops(fixture),
  );
  expect(unexpectedStaleMeasurementDrops).toBeLessThanOrEqual(
    DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.staleMeasurementDropsMax,
  );
  if (
    !hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "measurementCacheHitRate",
    )
  ) {
    expect(diagnostics.measurementCacheHitRate).toBeGreaterThanOrEqual(
      DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.measurementCacheHitRate,
    );
  }
}

function isDetachedScrollOperation(
  operation: TranscriptHarnessOperation,
): operation is Extract<
  TranscriptHarnessOperation,
  { kind: "scroll" | "scrollToRowOffset" }
> {
  return (
    (operation.kind === "scroll" || operation.kind === "scrollToRowOffset") &&
    operation.expectedAnchor === "row"
  );
}

function isDelayedLayoutOperation(
  operation: TranscriptHarnessOperation,
): operation is Extract<
  TranscriptHarnessOperation,
  { kind: "codeHighlightComplete" | "imageLoad" | "resizeMcpApp" }
> {
  return (
    operation.kind === "codeHighlightComplete" ||
    operation.kind === "imageLoad" ||
    operation.kind === "resizeMcpApp"
  );
}

function requireVisibleRow(
  row: TranscriptVisibleRowSnapshot | null,
  context: string,
): TranscriptVisibleRowSnapshot {
  expect(row, context).not.toBeNull();
  return row as TranscriptVisibleRowSnapshot;
}

function formatVisibleRows(rows: readonly TranscriptVisibleRowSnapshot[]) {
  return rows
    .map(
      (row) =>
        `${row.rowId} message=${row.messageId ?? "none"} anchor=${row.anchorPriority ?? "none"}`,
    )
    .join(", ");
}

function requireVisibleFragmentRow(
  snapshot: TranscriptScrollSnapshot,
  {
    messageId,
    rowIdIncludes,
    anchorPriority,
    context,
  }: {
    messageId: string;
    rowIdIncludes: string;
    anchorPriority?: string;
    context: string;
  },
): TranscriptVisibleRowSnapshot {
  const row = snapshot.visibleRows.find(
    (candidate) =>
      candidate.messageId === messageId &&
      candidate.rowId.includes(rowIdIncludes) &&
      (anchorPriority == null || candidate.anchorPriority === anchorPriority),
  );
  expect(
    row,
    `${context}; visible rows: ${formatVisibleRows(snapshot.visibleRows)}`,
  ).toBeDefined();
  return row as TranscriptVisibleRowSnapshot;
}

function requireVisibleMessageRow(
  snapshot: TranscriptScrollSnapshot,
  {
    messageId,
    anchorPriority,
    context,
  }: {
    messageId: string;
    anchorPriority?: string;
    context: string;
  },
): TranscriptVisibleRowSnapshot {
  const row = snapshot.visibleRows.find(
    (candidate) =>
      candidate.messageId === messageId &&
      (anchorPriority == null || candidate.anchorPriority === anchorPriority),
  );
  expect(
    row,
    `${context}; visible rows: ${formatVisibleRows(snapshot.visibleRows)}`,
  ).toBeDefined();
  return row as TranscriptVisibleRowSnapshot;
}

function expectDetachedScrollEvidence(
  operationEvidence: readonly TranscriptOperationEvidence[],
  diagnostics: TranscriptDiagnostics,
  fixture: ReturnType<typeof buildTranscriptFixture>,
) {
  if (
    hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "detachedScrollEvidence",
    )
  ) {
    return;
  }

  const detachedScrollEvidence = operationEvidence.filter((evidence) =>
    isDetachedScrollOperation(evidence.operation),
  );

  for (const evidence of detachedScrollEvidence) {
    expect(
      evidence.after.nearBottom,
      `operation ${evidence.operationIndex} should detach from bottom-follow after upward scroll`,
    ).toBe(false);
    requireVisibleRow(
      evidence.after.firstAnchorableVisibleRow,
      `operation ${evidence.operationIndex} should capture a visible row anchor after upward scroll`,
    );
  }
}

function expectDelayedLayoutPreservesDetachedAnchor(
  operationEvidence: readonly TranscriptOperationEvidence[],
  diagnostics: TranscriptDiagnostics,
  fixture: ReturnType<typeof buildTranscriptFixture>,
) {
  const firstDetachedScrollIndex = operationEvidence.findIndex((evidence) =>
    isDetachedScrollOperation(evidence.operation),
  );
  expect(
    firstDetachedScrollIndex,
    "fixture should include a detached scroll before delayed layout operations",
  ).toBeGreaterThanOrEqual(0);

  if (
    hasRealBridgeProofClassification(
      diagnostics,
      fixture,
      "delayedLayoutDetachedAnchor",
    )
  ) {
    return;
  }

  for (const evidence of operationEvidence.slice(
    firstDetachedScrollIndex + 1,
  )) {
    if (!isDelayedLayoutOperation(evidence.operation)) {
      continue;
    }

    const beforeRow = requireVisibleRow(
      evidence.before.firstAnchorableVisibleRow,
      `operation ${evidence.operationIndex} should have a visible row before delayed layout`,
    );
    const afterRow = requireVisibleRow(
      evidence.after.firstAnchorableVisibleRow,
      `operation ${evidence.operationIndex} should have a visible row after delayed layout`,
    );

    expect(
      evidence.after.nearBottom,
      `operation ${evidence.operationIndex} should not snap back to bottom after delayed layout`,
    ).toBe(false);

    if (
      beforeRow.messageId != null &&
      beforeRow.messageId !== evidence.operation.messageId
    ) {
      expect(
        afterRow.rowId,
        `operation ${evidence.operationIndex} should preserve the detached anchor row id`,
      ).toBe(beforeRow.rowId);
      const anchorDeltaPx = Math.abs(afterRow.topPx - beforeRow.topPx);
      const mcpRowChromeTolerancePx = getRealBridgeProofMcpRowChromeTolerancePx(
        {
          bridgeKind: diagnostics.bridgeKind,
          fixtureName: fixture.name,
        },
      );
      const classifiedMcpChromeDelta =
        evidence.operation.kind === "resizeMcpApp" &&
        mcpRowChromeTolerancePx != null &&
        diagnostics.scrollCorrectionP95Px <=
          DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionP95Px &&
        anchorDeltaPx <= mcpRowChromeTolerancePx;

      if (!classifiedMcpChromeDelta) {
        expect(
          anchorDeltaPx,
          `operation ${evidence.operationIndex} should preserve detached anchor offset`,
        ).toBeLessThanOrEqual(
          DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionP95Px,
        );
      }
    }
  }
}

function evidenceForOperation<K extends TranscriptHarnessOperation["kind"]>(
  operationEvidence: readonly TranscriptOperationEvidence[],
  kind: K,
): Extract<TranscriptOperationEvidence, { operation: { kind: K } }> {
  const evidence = operationEvidence.find(
    (candidate) => candidate.operation.kind === kind,
  );
  expect(evidence, `fixture should include ${kind} operation`).toBeDefined();
  return evidence as Extract<
    TranscriptOperationEvidence,
    { operation: { kind: K } }
  >;
}

function expectScrollTopPreserved(evidence: TranscriptOperationEvidence) {
  expect(
    Math.abs(evidence.after.scrollTop - evidence.before.scrollTop),
    `operation ${evidence.operationIndex} should preserve current scrollTop`,
  ).toBeLessThanOrEqual(
    DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionP95Px,
  );
}

function expectPr928FragmentTailEvidence(
  diagnostics: TranscriptDiagnostics,
  result: TranscriptRendererRunResult,
) {
  const bridgeKind = diagnostics.bridgeKind ?? "";
  const sameIdRevision = evidenceForOperation(
    result.operationEvidence,
    "changeRowRevision",
  );
  const wholeRowSplit = evidenceForOperation(
    result.operationEvidence,
    "splitMessageRows",
  );
  const tailPromotion = evidenceForOperation(
    result.operationEvidence,
    "promoteStreamingTail",
  );

  expectScrollTopPreserved(sameIdRevision);
  expectScrollTopPreserved(wholeRowSplit);
  expectScrollTopPreserved(tailPromotion);

  const sameIdBefore = requireVisibleRow(
    sameIdRevision.before.firstAnchorableVisibleRow,
    "same-id revision proof should start from a row anchor",
  );
  const sameIdAfter = requireVisibleRow(
    sameIdRevision.after.firstAnchorableVisibleRow,
    "same-id revision proof should recapture a row anchor",
  );
  expect(sameIdAfter.rowId).toBe(sameIdBefore.rowId);
  expect(sameIdAfter.heightRevision).not.toBe(sameIdBefore.heightRevision);

  requireVisibleFragmentRow(wholeRowSplit.after, {
    messageId: "pr928-whole",
    rowIdIncludes: "block-0",
    anchorPriority: "stable",
    context: "whole-row split proof should show the split fragment row",
  });

  const splitAfter = requireVisibleRow(
    wholeRowSplit.after.firstAnchorableVisibleRow,
    "whole-row split proof should recapture a fragment anchor",
  );
  expect(splitAfter.messageId).toBe("pr928-whole");
  expect(splitAfter.rowId).toContain("block-0");
  expect(splitAfter.anchorPriority).toBe("stable");

  expect(
    diagnostics.pr928SameIdStaleRevisionProofs ?? 0,
  ).toBeGreaterThanOrEqual(1);
  expect(diagnostics.pr928WholeRowSplitProofs ?? 0).toBeGreaterThanOrEqual(1);

  if (bridgeKind === "local-dom-renderer-bridge") {
    requireVisibleFragmentRow(tailPromotion.before, {
      messageId: "pr928-tail",
      rowIdIncludes: "stream-tail",
      anchorPriority: "streaming",
      context:
        "tail promotion proof should start with the visible streaming tail",
    });
    requireVisibleFragmentRow(tailPromotion.after, {
      messageId: "pr928-tail",
      rowIdIncludes: "stream-tail",
      anchorPriority: "streaming",
      context: "tail promotion proof should keep a visible streaming tail row",
    });

    const tailBefore = requireVisibleRow(
      tailPromotion.before.firstAnchorableVisibleRow,
      "tail promotion proof should start from the mutable tail",
    );
    const tailAfter = requireVisibleRow(
      tailPromotion.after.firstAnchorableVisibleRow,
      "tail promotion proof should recapture the completed fragment",
    );
    expect(tailBefore.rowId).toContain("stream-tail");
    expect(tailBefore.anchorPriority).toBe("streaming");
    expect(tailAfter.messageId).toBe("pr928-tail");
    expect(tailAfter.rowId).toContain("stream-block-0");
    expect(tailAfter.anchorPriority).toBe("stable");

    expect(
      diagnostics.pr928StreamingTailPromotionProofs ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(diagnostics.staleAnchorsDropped ?? 0).toBeGreaterThanOrEqual(2);
    expect(diagnostics.missingAnchorsDropped ?? 0).toBeGreaterThanOrEqual(1);
    expect(diagnostics.recapturedAnchors ?? 0).toBeGreaterThanOrEqual(3);
    return;
  }

  requireVisibleMessageRow(tailPromotion.before, {
    messageId: "pr928-tail",
    anchorPriority: "streaming",
    context:
      "tail promotion proof should start with the visible streaming tail message",
  });
  requireVisibleMessageRow(tailPromotion.after, {
    messageId: "pr928-tail",
    anchorPriority: "streaming",
    context:
      "tail promotion proof should keep the streaming tail message visible",
  });

  expect(diagnostics.staleAnchorsDropped ?? 0).toBeGreaterThanOrEqual(1);
  expect(diagnostics.recapturedAnchors ?? 0).toBeGreaterThanOrEqual(1);
}

function expectPr928RendererEvidence(
  diagnostics: TranscriptDiagnostics,
  fixture: ReturnType<typeof buildTranscriptFixture>,
  result: TranscriptRendererRunResult,
) {
  const allowedSessionStaleDrops =
    getAllowedSessionStaleMeasurementDrops(fixture);
  expect(diagnostics.staleMeasurementDrops).toBeLessThanOrEqual(
    allowedSessionStaleDrops,
  );
  expectDetachedScrollEvidence(result.operationEvidence, diagnostics, fixture);

  if (
    fixture.name === "dynamic-media-code" ||
    fixture.name === "mcp-dynamic-rows"
  ) {
    if (isRealBridgeProofRun(diagnostics.bridgeKind)) {
      expectDelayedLayoutPreservesDetachedAnchor(
        result.operationEvidence,
        diagnostics,
        fixture,
      );
    }
    if (
      !hasRealBridgeProofClassification(
        diagnostics,
        fixture,
        "scrollCorrectionP95Px",
      )
    ) {
      expect(diagnostics.scrollCorrectionP95Px).toBeLessThanOrEqual(
        DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.scrollCorrectionP95Px,
      );
    }
  }

  if (fixture.name === "pr928-fragment-tail") {
    expectPr928FragmentTailEvidence(diagnostics, result);
  }

  if (allowedSessionStaleDrops > 0) {
    expect(diagnostics.staleMeasurementSessionDrops).toBeLessThanOrEqual(
      allowedSessionStaleDrops,
    );
  }
}

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;
const scenarios = parseList<TranscriptFixtureName>(
  process.env.TRANSCRIPT_VIRTUALIZATION_SCENARIOS,
  DEFAULT_SCENARIOS,
);
const rendererModes = parseList<TranscriptRendererMode>(
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERERS,
  DEFAULT_RENDERER_MODES,
);

test.describe("transcript virtualization parity and performance harness", () => {
  for (const scenario of scenarios) {
    for (const rendererMode of rendererModes) {
      test(`${rendererMode} renderer handles ${scenario}`, async ({
        page,
      }, testInfo) => {
        const fixture = buildTranscriptFixture(scenario);
        const result = await runTranscriptRendererHarness(page, {
          rendererUrl,
          rendererMode,
          fixture,
        });
        const diagnostics = requireDiagnostics(result.diagnostics);
        const productionDiagnostics = requireProductionDiagnostics(
          result.productionDiagnostics,
        );

        await testInfo.attach("transcript-renderer-diagnostics.json", {
          body: JSON.stringify(
            {
              scenario,
              rendererMode,
              rendererUrl,
              fixtureVersion: fixture.version,
              timeToFirstVisibleTailThresholdMs:
                getTimeToFirstVisibleTailThresholdMs(fixture, rendererMode),
              diagnostics: result.diagnostics,
              productionDiagnostics: result.productionDiagnostics,
              browserMetrics: result.metrics,
              productionTimingMetrics: result.productionTimingMetrics,
              bridgeTimingExclusionWindows: result.bridgeTimingExclusionWindows,
              operationTimingMetrics: result.operationTimingMetrics,
              productionOperationTimingMetrics:
                result.productionOperationTimingMetrics,
              viewport: result.viewport,
              operationEvidence: result.operationEvidence,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });

        expect(diagnostics.blankViewportPixels).toBeLessThanOrEqual(
          DOM_BOUNDED_FULL_HISTORY_THRESHOLDS.blankViewportPixels,
        );

        if (rendererMode === "virtual") {
          expectPr928RendererEvidence(diagnostics, fixture, result);
          expectVirtualDiagnosticsWithinThresholds(
            diagnostics,
            result,
            fixture,
            rendererMode,
          );
          if (isRealBridgeProofRun(diagnostics.bridgeKind)) {
            expect(productionDiagnostics?.bridgeKind).toBe(
              "production-virtual-message-timeline",
            );
            expectProductionTimingExcludesBridgeFixtureWork(result, fixture);
          }
          if (isRealProductionTimingProof(diagnostics, productionDiagnostics)) {
            expectProductionTimingWithinThresholds(
              diagnostics,
              productionDiagnostics,
              result,
              fixture,
            );
          }
        }
      });
    }
  }
});
