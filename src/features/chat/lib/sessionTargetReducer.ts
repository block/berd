import type { AcpReasoningEffortConfigSnapshot } from "@/shared/api/acpSessionConfigSnapshots";
import {
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";

export type TargetTransitionOrigin =
  | "picker"
  | "home"
  | "persona"
  | "draft"
  | "queued-send"
  | "activation"
  | "berdctl"
  | "hydration"
  | "recovery"
  | "send";

export interface SessionTargetMetadata {
  target: SessionExecutionTarget;
  reasoningEffort?: AcpReasoningEffortConfigSnapshot;
}

export type SessionTargetSyncState =
  | { status: "unresolved"; hydratedTarget?: SessionExecutionTarget }
  | {
      status: "settled";
      committed: SessionExecutionTarget;
      metadata?: SessionTargetMetadata;
    }
  | {
      status: "transitioning";
      operationId: string;
      origin: TargetTransitionOrigin;
      previous?: SessionExecutionTarget;
      desired: SessionExecutionTarget;
      effective?: SessionExecutionTarget;
      phase: "resolving" | "preparing" | "applying" | "awaiting-ack";
      metadata?: SessionTargetMetadata;
    }
  | {
      status: "failed";
      operationId: string;
      desired: SessionExecutionTarget;
      fallback?: SessionExecutionTarget;
      error: unknown;
      retryable: boolean;
    };

export type SessionTargetEvent =
  | {
      type: "HYDRATE";
      target: SessionExecutionTarget;
      metadata?: SessionTargetMetadata;
    }
  | {
      type: "SELECT";
      operationId: string;
      origin: TargetTransitionOrigin;
      desired: SessionExecutionTarget;
    }
  | { type: "RESOLVED"; operationId: string; effective: SessionExecutionTarget }
  | {
      type: "PHASE_CHANGED";
      operationId: string;
      phase: "preparing" | "applying" | "awaiting-ack";
    }
  | {
      type: "METADATA_OBSERVED";
      operationId: string;
      metadata: SessionTargetMetadata;
    }
  | {
      type: "ACKNOWLEDGED";
      operationId: string;
      target: SessionExecutionTarget;
      metadata?: SessionTargetMetadata;
    }
  | {
      type: "SUPERSEDED";
      operationId: string;
    }
  | {
      type: "REJECTED";
      operationId: string;
      error: unknown;
      retryable?: boolean;
    }
  | { type: "SESSION_REMOVED" };

function committedTarget(
  state: SessionTargetSyncState,
): SessionExecutionTarget | undefined {
  if (state.status === "settled") return state.committed;
  if (state.status === "transitioning") return state.previous;
  if (state.status === "failed") return state.fallback;
  return state.hydratedTarget;
}

export function reduceSessionTarget(
  state: SessionTargetSyncState,
  event: SessionTargetEvent,
): SessionTargetSyncState {
  switch (event.type) {
    case "SESSION_REMOVED":
      return { status: "unresolved" };
    case "HYDRATE": {
      const target = normalizeSessionExecutionTarget(event.target);
      if (
        state.status === "settled" &&
        sameSessionExecutionTarget(state.committed, target) &&
        !event.metadata
      ) {
        return state;
      }
      return { status: "settled", committed: target, metadata: event.metadata };
    }
    case "SELECT":
      return {
        status: "transitioning",
        operationId: event.operationId,
        origin: event.origin,
        previous: committedTarget(state),
        desired: normalizeSessionExecutionTarget(event.desired),
        phase: "resolving",
      };
    case "RESOLVED":
      return state.status === "transitioning" &&
        state.operationId === event.operationId
        ? {
            ...state,
            effective: normalizeSessionExecutionTarget(event.effective),
          }
        : state;
    case "PHASE_CHANGED":
      return state.status === "transitioning" &&
        state.operationId === event.operationId
        ? { ...state, phase: event.phase }
        : state;
    case "METADATA_OBSERVED":
      return state.status === "transitioning" &&
        state.operationId === event.operationId
        ? { ...state, metadata: event.metadata }
        : state;
    case "ACKNOWLEDGED":
      return state.status === "transitioning" &&
        state.operationId === event.operationId
        ? {
            status: "settled",
            committed: normalizeSessionExecutionTarget(event.target),
            metadata: event.metadata ?? state.metadata,
          }
        : state;
    case "SUPERSEDED":
      if (
        state.status !== "transitioning" ||
        state.operationId !== event.operationId
      ) {
        return state;
      }
      return state.previous
        ? { status: "settled", committed: state.previous }
        : { status: "unresolved" };
    case "REJECTED":
      return state.status === "transitioning" &&
        state.operationId === event.operationId
        ? {
            status: "failed",
            operationId: event.operationId,
            desired: state.desired,
            fallback: state.previous,
            error: event.error,
            retryable: event.retryable ?? true,
          }
        : state;
  }
}
