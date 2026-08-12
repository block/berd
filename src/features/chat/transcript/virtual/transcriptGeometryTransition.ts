import type { TranscriptScrollCorrection } from "./transcriptVirtualTypes";

/**
 * Browser-independent viewport state used by transcript geometry.
 *
 * `observedScrollTop` is only changed by an observe event. A proposal is an
 * effect for the browser owner to attempt; it deliberately does not update the
 * observed position. Keeping the pending effect in state makes retries
 * deterministic and prevents an unacknowledged write from being emitted twice.
 */
export interface TranscriptGeometryViewportState {
  observedScrollTop: number;
  pendingScroll: TranscriptScrollCorrection | null;
}

export type TranscriptGeometryViewportEvent =
  | { type: "observe"; scrollTop: number; maxScrollTop: number }
  | {
      type: "propose";
      reason: TranscriptScrollCorrection["reason"];
      scrollTop: number;
      maxScrollTop: number;
      epsilon: number;
    };

export interface TranscriptGeometryViewportTransition {
  state: TranscriptGeometryViewportState;
  effect: TranscriptScrollCorrection | null;
}

export function transitionTranscriptGeometryViewport(
  state: TranscriptGeometryViewportState,
  event: TranscriptGeometryViewportEvent,
): TranscriptGeometryViewportTransition {
  const maxScrollTop = finiteNonNegative(event.maxScrollTop);
  if (event.type === "observe") {
    return {
      state: {
        observedScrollTop: clampFinite(event.scrollTop, maxScrollTop),
        pendingScroll: null,
      },
      effect: null,
    };
  }

  if (
    !Number.isFinite(event.scrollTop) ||
    !Number.isFinite(event.maxScrollTop)
  ) {
    return { state, effect: null };
  }

  const epsilon = finiteNonNegative(event.epsilon);
  const nextScrollTop = clampFinite(event.scrollTop, maxScrollTop);
  if (Math.abs(nextScrollTop - state.observedScrollTop) <= epsilon) {
    return {
      state: { ...state, pendingScroll: null },
      effect: null,
    };
  }

  const proposal: TranscriptScrollCorrection = {
    reason: event.reason,
    previousScrollTop: state.observedScrollTop,
    nextScrollTop,
    delta: nextScrollTop - state.observedScrollTop,
  };
  if (
    state.pendingScroll &&
    Math.abs(state.pendingScroll.nextScrollTop - proposal.nextScrollTop) <=
      epsilon
  ) {
    return { state, effect: null };
  }

  return {
    state: { ...state, pendingScroll: proposal },
    effect: proposal,
  };
}

function clampFinite(value: number, max: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.min(max, Math.max(0, finite));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
