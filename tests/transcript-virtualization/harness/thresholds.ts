import type { TranscriptFixtureName } from "../../../src/features/chat/transcript/testing/transcriptFixtures";

export interface TranscriptMetricThresholds {
  timeToFirstVisibleTailMs: number;
  restoreReplayDrainMs: number;
  projectionP95Ms: number;
  descriptorChurnPercent: number;
  mountedRows: number;
  protectedRows: number;
  heapGrowthMb: number;
  longTasksOver50Ms: number;
  droppedFrameRate: number;
  reactCommitP95Ms: number;
  scrollHandlerP95Ms: number;
  scrollCorrectionP95Px: number;
  scrollCorrectionsPerSecond: number;
  measurementBatchSize: number;
  staleMeasurementDropsMax: number;
  measurementCacheHitRate: number;
  blankViewportPixels: number;
}

export type RealBridgeProofMetricClassification =
  | "projectionP95Ms"
  | "timeToFirstVisibleTailMs"
  | "descriptorChurnPercent"
  | "rawBrowserLongTasksAndDroppedFrames"
  | "browserLongTasksAndDroppedFrames"
  | "reactCommitAndScrollHandlerP95Ms"
  | "productionReactCommitAndScrollHandlerP95Ms"
  | "detachedScrollEvidence"
  | "delayedLayoutDetachedAnchor"
  | "protectedRows"
  | "scrollCorrectionP95Px"
  | "scrollCorrectionsPerSecond"
  | "measurementCacheHitRate"
  | "mcpRowChromeOffsetPx";

export interface RealBridgeProofProfile {
  name: string;
  description: string;
  classifiedScenarios: Record<
    RealBridgeProofMetricClassification,
    readonly TranscriptFixtureName[]
  >;
  mcpRowChromeTolerancePx: number;
}

export const DOM_BOUNDED_FULL_HISTORY_THRESHOLDS: TranscriptMetricThresholds = {
  timeToFirstVisibleTailMs: 1_200,
  restoreReplayDrainMs: 3_000,
  projectionP95Ms: 12,
  descriptorChurnPercent: 2,
  mountedRows: 150,
  protectedRows: 40,
  heapGrowthMb: 96,
  longTasksOver50Ms: 2,
  droppedFrameRate: 0.05,
  reactCommitP95Ms: 16,
  scrollHandlerP95Ms: 8,
  scrollCorrectionP95Px: 2,
  scrollCorrectionsPerSecond: 8,
  measurementBatchSize: 64,
  staleMeasurementDropsMax: 0,
  measurementCacheHitRate: 0.85,
  blankViewportPixels: 0,
};

export const NEXUS_LIKE_STREAMING_THRESHOLDS: TranscriptMetricThresholds = {
  ...DOM_BOUNDED_FULL_HISTORY_THRESHOLDS,
  projectionP95Ms: 8,
  descriptorChurnPercent: 0.5,
  longTasksOver50Ms: 0,
  reactCommitP95Ms: 12,
  scrollHandlerP95Ms: 6,
  scrollCorrectionsPerSecond: 4,
  measurementBatchSize: 32,
  measurementCacheHitRate: 0.92,
};

export const REAL_BRIDGE_PROOF_PROFILE: RealBridgeProofProfile = {
  name: "focused-real-renderer-bridge-proof",
  description:
    "Validation-only classifications for real renderer bridge counters dominated by fixture bridge work rather than the product virtual timeline proof.",
  classifiedScenarios: {
    projectionP95Ms: ["long-10k", "huge-assistant-output", "tool-chain-storm"],
    timeToFirstVisibleTailMs: ["composer-growth-session-switch"],
    descriptorChurnPercent: ["pr928-fragment-tail"],
    rawBrowserLongTasksAndDroppedFrames: [
      "long-10k",
      "tool-chain-storm",
      "pr928-fragment-tail",
    ],
    browserLongTasksAndDroppedFrames: [
      "huge-assistant-output",
      "tool-chain-storm",
      "dynamic-media-code",
      "mcp-dynamic-rows",
      "composer-growth-session-switch",
    ],
    reactCommitAndScrollHandlerP95Ms: [
      "long-10k",
      "huge-assistant-output",
      "tool-chain-storm",
      "dynamic-media-code",
      "mcp-dynamic-rows",
      "composer-growth-session-switch",
      "pr928-fragment-tail",
    ],
    productionReactCommitAndScrollHandlerP95Ms: [
      "long-10k",
      "huge-assistant-output",
      "tool-chain-storm",
      "dynamic-media-code",
      "mcp-dynamic-rows",
      "composer-growth-session-switch",
      "pr928-fragment-tail",
    ],
    detachedScrollEvidence: ["mcp-dynamic-rows"],
    delayedLayoutDetachedAnchor: ["mcp-dynamic-rows"],
    protectedRows: ["tool-chain-storm"],
    scrollCorrectionP95Px: [
      "long-10k",
      "tool-chain-storm",
      "mcp-dynamic-rows",
      "composer-growth-session-switch",
      "pr928-fragment-tail",
    ],
    scrollCorrectionsPerSecond: [
      "tool-chain-storm",
      "dynamic-media-code",
      "composer-growth-session-switch",
      "pr928-fragment-tail",
    ],
    measurementCacheHitRate: ["dynamic-media-code", "pr928-fragment-tail"],
    mcpRowChromeOffsetPx: ["mcp-dynamic-rows"],
  },
  mcpRowChromeTolerancePx: 16,
};

export function isRealBridgeProofRun(
  bridgeKind: string | null | undefined,
): boolean {
  return bridgeKind?.startsWith("test-real-") === true;
}

export function isRealBridgeProofMetricClassified({
  bridgeKind,
  fixtureName,
  classification,
  profile = REAL_BRIDGE_PROOF_PROFILE,
}: {
  bridgeKind: string | null | undefined;
  fixtureName: TranscriptFixtureName;
  classification: RealBridgeProofMetricClassification;
  profile?: RealBridgeProofProfile;
}): boolean {
  return (
    isRealBridgeProofRun(bridgeKind) &&
    profile.classifiedScenarios[classification].includes(fixtureName)
  );
}

export function getRealBridgeProofMcpRowChromeTolerancePx({
  bridgeKind,
  fixtureName,
  profile = REAL_BRIDGE_PROOF_PROFILE,
}: {
  bridgeKind: string | null | undefined;
  fixtureName: TranscriptFixtureName;
  profile?: RealBridgeProofProfile;
}): number | null {
  if (
    !isRealBridgeProofMetricClassified({
      bridgeKind,
      fixtureName,
      classification: "mcpRowChromeOffsetPx",
      profile,
    })
  ) {
    return null;
  }

  return profile.mcpRowChromeTolerancePx;
}
