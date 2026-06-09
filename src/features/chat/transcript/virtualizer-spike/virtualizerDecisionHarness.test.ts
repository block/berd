import { describe, expect, it } from "vitest";
import {
  ReferenceTranscriptController,
  TanStackSpikeAdapter,
  customRangeWithPinnedIndexes,
  evaluateCountOverscanCoverage,
  makeRows,
  type MeasurementToken,
  type SpikeRow,
} from "./virtualizerDecisionHarness";

const SESSION_ID = "session-a";
const WIDTH_SCOPE = "w:720";

function tokenFor(row: SpikeRow, overrides: Partial<MeasurementToken> = {}) {
  return {
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    widthScope: WIDTH_SCOPE,
    rowId: row.id,
    heightRevision: row.heightRevision,
    ...overrides,
  };
}

function createTanStackAdapter(
  rows: readonly SpikeRow[],
  scrollTop = 0,
  options: Partial<ConstructorParameters<typeof TanStackSpikeAdapter>[0]> = {},
) {
  return new TanStackSpikeAdapter({
    rows,
    viewportHeight: 500,
    width: 720,
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    widthScope: WIDTH_SCOPE,
    scrollTop,
    ...options,
  });
}

describe("virtualizer decision spike harness", () => {
  it("keeps bottom-following users pinned when the Goose adapter scrolls after append", () => {
    const rows = makeRows(20, () => 100);
    const nextRows = [...rows, ...makeRows(1, () => 120, "new")];
    const reference = new ReferenceTranscriptController(rows);
    const tanStack = createTanStackAdapter(rows);

    tanStack.scrollToRow(rows.at(-1)?.id ?? "", "end");
    expect(tanStack.getScrollTop()).toBe(reference.getBottomScrollTop(500));

    reference.setRows(nextRows);
    tanStack.appendRowsFollowingBottom(nextRows);

    expect(tanStack.getScrollTop()).toBe(reference.getBottomScrollTop(500));
    expect(tanStack.getScrollTop()).toBe(tanStack.getBottomScrollTop());
  });

  it("uses updated TanStack end-anchor APIs to detect and follow appends at the end", () => {
    const rows = makeRows(20, () => 100);
    const tanStack = createTanStackAdapter(rows, 1496, {
      anchorTo: "end",
      followOnAppend: "auto",
      scrollEndThreshold: 5,
    });
    const nextRows = [...rows, ...makeRows(2, () => 120, "new")];

    expect(tanStack.getDistanceFromEnd()).toBe(4);
    expect(tanStack.isAtEnd()).toBe(true);
    expect(tanStack.isAtEnd(1)).toBe(false);

    tanStack.setRows(nextRows);

    expect(tanStack.getScrollTop()).toBe(tanStack.getBottomScrollTop());
    expect(tanStack.getDistanceFromEnd()).toBe(0);
    expect(tanStack.isAtEnd()).toBe(true);
  });

  it("keeps detached users detached when updated TanStack follow-on-append is enabled", () => {
    const rows = makeRows(20, () => 100);
    const tanStack = createTanStackAdapter(rows, 1200, {
      anchorTo: "end",
      followOnAppend: "auto",
      scrollEndThreshold: 5,
    });
    const nextRows = [...rows, ...makeRows(2, () => 120, "new")];

    expect(tanStack.isAtEnd()).toBe(false);

    tanStack.setRows(nextRows);

    expect(tanStack.getScrollTop()).toBe(1200);
    expect(tanStack.isAtEnd()).toBe(false);
  });

  it("uses updated TanStack scrollToEnd to reach the transcript end explicitly", () => {
    const rows = makeRows(20, () => 100);
    const tanStack = createTanStackAdapter(rows, 0, {
      anchorTo: "end",
      scrollEndThreshold: 5,
    });

    tanStack.scrollToEnd();

    expect(tanStack.getScrollTop()).toBe(tanStack.getBottomScrollTop());
    expect(tanStack.getDistanceFromEnd()).toBe(0);
    expect(tanStack.isAtEnd()).toBe(true);
  });

  it("preserves a detached row anchor through prepend simulation", () => {
    const rows = makeRows(20, () => 100);
    const prependedRows = makeRows(
      3,
      (index) => [80, 140, 60][index] ?? 100,
      "older",
    );
    const nextRows = [...prependedRows, ...rows];
    const reference = new ReferenceTranscriptController(rows);
    const tanStack = createTanStackAdapter(rows, 1025);
    const referenceAnchor = reference.captureAnchor(1025);
    const tanStackAnchor = tanStack.captureAnchor();

    reference.setRows(nextRows);
    tanStack.prependRowsPreservingAnchor(nextRows, tanStackAnchor);

    expect(tanStackAnchor).toEqual(referenceAnchor);
    expect(tanStack.getScrollTop()).toBe(
      reference.restoreAnchor(referenceAnchor),
    );
  });

  it("matches custom anchor correction when a measured row above the viewport grows", () => {
    const rows = makeRows(20, () => 100);
    const reference = new ReferenceTranscriptController(rows);
    const tanStack = createTanStackAdapter(rows, 1020);
    const anchor = reference.captureAnchor(1020);

    reference.measureRow(rows[5]?.id ?? "", 180);
    const applied = tanStack.applyMeasurement(
      tokenFor(rows[5] as SpikeRow),
      180,
    );

    expect(applied).toBe(true);
    expect(tanStack.getScrollTop()).toBe(reference.restoreAnchor(anchor));
  });

  it("drops stale measurements before they reach the virtualizer cache", () => {
    const rows = makeRows(20, () => 100);
    const tanStack = createTanStackAdapter(rows, 1020);

    const staleEpochApplied = tanStack.applyMeasurement(
      tokenFor(rows[5] as SpikeRow, { sessionEpoch: 0 }),
      180,
    );
    const staleRevisionApplied = tanStack.applyMeasurement(
      tokenFor(rows[5] as SpikeRow, { heightRevision: "stale" }),
      180,
    );

    expect(staleEpochApplied).toBe(false);
    expect(staleRevisionApplied).toBe(false);
    expect(tanStack.getScrollTop()).toBe(1020);

    expect(tanStack.applyMeasurement(tokenFor(rows[5] as SpikeRow), 180)).toBe(
      true,
    );
    expect(tanStack.getScrollTop()).toBe(1100);
  });

  it("can resolve an initially unmounted controlled target by stable row id", () => {
    const rows = makeRows(100, () => 100);
    const tanStack = createTanStackAdapter(rows, 0);

    expect(tanStack.getVisibleRowIds()).not.toContain("row-80");

    tanStack.scrollToRow("row-80", "center");

    expect(tanStack.getVisibleRowIds()).toContain("row-80");
  });

  it("records when count overscan undershoots a required pixel lookbehind budget", () => {
    const rows = makeRows(200, () => 20);
    const coverage = evaluateCountOverscanCoverage({
      rows,
      scrollTop: 2400,
      viewportHeight: 500,
      overscanCount: 5,
      requiredBeforePx: 1200,
    });

    expect(coverage.renderedBeforePx).toBe(100);
    expect(coverage.satisfiesRequiredBeforePx).toBe(false);
  });

  it("shows TanStack range extraction can include pinned keepalive rows separately from overscan", () => {
    const indexes = customRangeWithPinnedIndexes(
      { startIndex: 40, endIndex: 45, overscan: 2, count: 100 },
      [3, 44, 95],
    );

    expect(indexes).toEqual([3, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 95]);
  });
});
