export interface WebkitScrollbarSample {
  kind: "frame" | "scroll" | "mutation" | "app-write";
  scrollTop: number;
  scrollHeight: number;
  renderRange: string;
}

export interface WebkitScrollbarAnalysis {
  distinctRanges: number;
  rangeTransitions: number;
  mutations: number;
  appWrites: number;
  largestInterEventGap: number;
  materialReversals: number;
}

export function analyzeWebkitScrollbarSamples(
  samples: readonly WebkitScrollbarSample[],
  materialBackwardScrollPx: number,
): WebkitScrollbarAnalysis {
  const distinctRanges = new Set(samples.map((entry) => entry.renderRange));
  const rangeTransitions = samples.reduce((count, entry, index) => {
    const previous = samples[index - 1];
    return previous && previous.renderRange !== entry.renderRange
      ? count + 1
      : count;
  }, 0);
  const scrollEvents = samples.filter((entry) => entry.kind === "scroll");
  const largestInterEventGap = scrollEvents.reduce((largest, entry, index) => {
    const previous = scrollEvents[index - 1];
    return previous
      ? Math.max(largest, Math.abs(entry.scrollTop - previous.scrollTop))
      : largest;
  }, 0);
  const materialReversals = samples.filter((entry, index) => {
    const previous = samples[index - 1];
    return (
      previous != null &&
      entry.scrollTop < previous.scrollTop - materialBackwardScrollPx
    );
  }).length;
  return {
    distinctRanges: distinctRanges.size,
    rangeTransitions,
    mutations: samples.filter((entry) => entry.kind === "mutation").length,
    appWrites: samples.filter((entry) => entry.kind === "app-write").length,
    largestInterEventGap,
    materialReversals,
  };
}
