import { describe, expect, it } from "vitest";
import {
  createTranscriptDiagnostics,
  createTranscriptDiagnosticsFromVirtualTimelineDiagnostics,
  TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION,
  TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS,
  validateTranscriptDiagnostics,
} from "./transcriptDiagnostics";

describe("transcript diagnostics schema", () => {
  it("creates a complete finite diagnostics payload", () => {
    const diagnostics = createTranscriptDiagnostics({
      mountedRows: 42,
      scrollCorrectionCount: 3,
      measurementAcceptedCount: 5,
      staleMeasurementRejectCount: 2,
    });

    expect(diagnostics.schemaVersion).toBe(
      TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION,
    );
    for (const key of TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS) {
      expect(Number.isFinite(diagnostics[key]), key).toBe(true);
    }
    expect(diagnostics).toMatchObject({
      mountedRows: 42,
      scrollCorrectionCount: 3,
      measurementAcceptedCount: 5,
      staleMeasurementRejectCount: 2,
    });
  });

  it("validates finite required metrics and preserves serializable metadata", () => {
    const result = validateTranscriptDiagnostics(
      createTranscriptDiagnostics({
        bridgeKind: "local-dom-renderer-bridge",
        rendererMode: "virtual",
        activeSessionId: "session-1",
        totalRows: 10_004,
        totalScrollHeight: 320_000,
        reactCommitSamples: [
          {
            startTime: 100,
            endTime: 112,
            durationMs: 12,
            source: "react-profiler",
          },
        ],
        scrollHandlerSamples: [
          {
            startTime: 120,
            endTime: 124,
            durationMs: 4,
            source: "scroll-listener",
          },
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      bridgeKind: "local-dom-renderer-bridge",
      rendererMode: "virtual",
      activeSessionId: "session-1",
      totalRows: 10_004,
      totalScrollHeight: 320_000,
      reactCommitSamples: [
        {
          startTime: 100,
          endTime: 112,
          durationMs: 12,
          source: "react-profiler",
        },
      ],
      scrollHandlerSamples: [
        {
          startTime: 120,
          endTime: 124,
          durationMs: 4,
          source: "scroll-listener",
        },
      ],
    });
  });

  it("reports missing and non-finite required metrics", () => {
    const result = validateTranscriptDiagnostics({
      ...createTranscriptDiagnostics(),
      mountedRows: Number.POSITIVE_INFINITY,
      staleMeasurementDrops: undefined,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        { key: "mountedRows", reason: "non-finite-number" },
        { key: "staleMeasurementDrops", reason: "missing" },
      ]),
    );
  });

  it("maps virtual timeline diagnostics into the shared schema", () => {
    const diagnostics =
      createTranscriptDiagnosticsFromVirtualTimelineDiagnostics(
        {
          renderer: "virtual-message-timeline",
          mode: "bounded-controller",
          sessionId: "session-1",
          sessionEpoch: 2,
          totalRows: 200,
          mountedRows: 42,
          offscreenShellMountedRows: 5,
          protectedRows: 3,
          descriptorChurn: 10,
          projectionDurationMs: 6.5,
          virtualUnmountingEnabled: true,
          virtualScrollHeight: 50_000,
          controller: {
            corrections: 4,
            staleMeasurementsDropped: 2,
            staleMeasurementEpochDrops: 1,
            staleMeasurementRevisionDrops: 1,
            lastCorrectionDeltaPx: 18,
          },
          measurement: {
            acceptedVisibleMeasurements: 7,
            acceptedOffscreenShellMeasurements: 2,
            acceptedOffscreenRealMeasurements: 1,
            controllerUpdateBatchMaxSize: 3,
            cacheHits: 8,
            cacheMisses: 2,
            staleMeasurementsDropped: 1,
            staleMeasurementWidthDrops: 1,
          },
          blockers: ["browser-validation-harness"],
          reactCommitSamples: [
            {
              startTime: 20,
              endTime: 26,
              durationMs: 6,
              source: "react-profiler",
            },
          ],
          scrollHandlerSamples: [
            {
              startTime: 30,
              endTime: 32,
              durationMs: 2,
              source: "scroll-listener",
            },
          ],
        },
        { elapsedMs: 2000 },
      );

    expect(validateTranscriptDiagnostics(diagnostics).errors).toEqual([]);
    expect(diagnostics).toMatchObject({
      bridgeKind: "production-virtual-message-timeline",
      rendererMode: "virtual",
      activeSessionId: "session-1",
      sessionEpoch: 2,
      totalRows: 200,
      logicalRows: 200,
      totalScrollHeight: 50_000,
      mountedRows: 42,
      offscreenShellMountedRows: 5,
      protectedRows: 3,
      descriptorChurnPercent: 5,
      projectionP95Ms: 6.5,
      projectionLastMs: 6.5,
      scrollCorrectionCount: 4,
      scrollCorrectionP95Px: 18,
      scrollCorrectionsPerSecond: 2,
      measurementBatchSize: 3,
      measurementAcceptedCount: 10,
      measurementCacheHitRate: 0.8,
      staleMeasurementDrops: 3,
      staleMeasurementRejectCount: 3,
      staleMeasurementEpochDrops: 1,
      staleMeasurementWidthDrops: 1,
      staleMeasurementRevisionDrops: 1,
      blockerIds: ["browser-validation-harness"],
      reactCommitSamples: [
        {
          startTime: 20,
          endTime: 26,
          durationMs: 6,
          source: "react-profiler",
        },
      ],
      scrollHandlerSamples: [
        {
          startTime: 30,
          endTime: 32,
          durationMs: 2,
          source: "scroll-listener",
        },
      ],
    });
  });

  it("uses logical tall-row budget for descriptor churn when raw churn is available", () => {
    const diagnostics =
      createTranscriptDiagnosticsFromVirtualTimelineDiagnostics({
        totalRows: 3,
        mountedRows: 3,
        descriptorChurn: 1,
        descriptorChurnPercent: 33.33333333333333,
        virtualScrollHeight: 110_869,
      });

    expect(diagnostics.logicalRows).toBe(80);
    expect(diagnostics.descriptorChurnPercent).toBe(1.25);
  });
});
