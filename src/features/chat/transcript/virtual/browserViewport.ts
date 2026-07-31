export interface TranscriptBrowserViewportSnapshot {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  viewportTop: number;
  viewportBottom: number;
}

export const MAX_BLANK_VIEWPORT_RECOVERY_ATTEMPTS = 2;

export interface TranscriptBrowserRowCoverage {
  blankViewportPixels: number;
  intersectingRealRowCount: number;
  realRowCount: number;
  viewport: TranscriptBrowserViewportSnapshot;
}

const REAL_TRANSCRIPT_ROW_SELECTOR = "[data-virtual-row-id]";
const MAX_INTENTIONAL_ROW_GAP_PX = 24;
const MAX_INTENTIONAL_EDGE_GAP_PX = 96;

/**
 * The browser is the authority for viewport recovery. Keep all recovery-time
 * DOM reads and writes behind this adapter so controller state cannot be
 * mistaken for what the user can actually see.
 */
export type TranscriptBrowserViewport = ReturnType<
  typeof createTranscriptBrowserViewport
>;

export function createTranscriptBrowserViewport(
  container: HTMLDivElement,
  transcriptRoot: HTMLElement,
) {
  const read = (): TranscriptBrowserViewportSnapshot => {
    const rect = container.getBoundingClientRect();
    const viewportHeight = Math.max(0, container.clientHeight || rect.height);
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      viewportHeight,
      viewportWidth: Math.max(0, container.clientWidth || rect.width),
      viewportTop: rect.top,
      viewportBottom: rect.top + viewportHeight,
    };
  };

  const readRealRowCoverage = (
    coverageRoot: HTMLElement = transcriptRoot,
  ): TranscriptBrowserRowCoverage => {
    const viewport = read();
    const intervals: Array<[number, number]> = [];
    const rows = coverageRoot.querySelectorAll<HTMLElement>(
      REAL_TRANSCRIPT_ROW_SELECTOR,
    );

    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const start = Math.max(viewport.viewportTop, rect.top);
      const end = Math.min(viewport.viewportBottom, rect.bottom);
      if (end > start) {
        intervals.push([start, end]);
      }
    }

    intervals.sort((left, right) => left[0] - right[0]);
    const mergedIntervals: Array<[number, number]> = [];
    for (const [start, end] of intervals) {
      const previous = mergedIntervals.at(-1);
      if (!previous || start > previous[1]) {
        mergedIntervals.push([start, end]);
      } else {
        previous[1] = Math.max(previous[1], end);
      }
    }

    let blankViewportPixels = viewport.viewportHeight;
    const firstInterval = mergedIntervals[0];
    const lastInterval = mergedIntervals.at(-1);
    if (firstInterval && lastInterval) {
      blankViewportPixels = Math.max(
        0,
        firstInterval[0] - viewport.viewportTop - MAX_INTENTIONAL_EDGE_GAP_PX,
      );
      for (let index = 1; index < mergedIntervals.length; index += 1) {
        const previous = mergedIntervals[index - 1];
        const current = mergedIntervals[index];
        if (previous && current) {
          blankViewportPixels += Math.max(
            0,
            current[0] - previous[1] - MAX_INTENTIONAL_ROW_GAP_PX,
          );
        }
      }
      blankViewportPixels += Math.max(
        0,
        viewport.viewportBottom - lastInterval[1] - MAX_INTENTIONAL_EDGE_GAP_PX,
      );
    }

    return {
      blankViewportPixels,
      intersectingRealRowCount: intervals.length,
      realRowCount: rows.length,
      viewport,
    };
  };

  const writeScrollTop = (
    scrollTop: number,
    behavior: ScrollBehavior = "auto",
  ) => {
    if (behavior !== "auto" && typeof container.scrollTo === "function") {
      container.scrollTo({ top: scrollTop, behavior });
    } else {
      container.scrollTop = scrollTop;
    }
    return read();
  };

  return { read, readRealRowCoverage, writeScrollTop };
}
