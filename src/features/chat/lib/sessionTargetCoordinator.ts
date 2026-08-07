import { acpPrepareSession } from "@/shared/api/acp";
import type {
  AcpModelConfigSnapshot,
  AcpReasoningEffortConfigSnapshot,
  AcpSessionConfigSnapshotContext,
  AcpSessionConfigSnapshots,
} from "@/shared/api/acpSessionConfigSnapshots";
import { repairManagedGooseModelSelection } from "@/features/providers/lib/managedModelSelectionRepair";
import { useChatSessionStore } from "../stores/chatSessionStore";
import {
  executionTargetFromGooseServeSession,
  gooseServeSelectionFromExecutionTarget,
} from "./gooseServeExecutionTarget";
import {
  materializeSessionExecutionModel,
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";
import {
  reduceSessionTarget,
  type SessionTargetMetadata,
  type SessionTargetSyncState,
  type TargetTransitionOrigin,
} from "./sessionTargetReducer";

export interface SessionTargetTransition {
  sessionId: string;
  target: SessionExecutionTarget;
  workingDir: string;
  prepareWorkingDir?: string;
  origin?: TargetTransitionOrigin;
  operationId?: string;
  requestId?: string;
  /** Ensure target-qualified reasoning metadata as part of this operation. */
  requireReasoningEffort?: boolean;
}

export type SessionTargetOutcome =
  | {
      status: "committed";
      applied: true;
      target: SessionExecutionTarget;
      resolvedTarget?: SessionExecutionTarget;
      configOptionsSnapshot?: AcpSessionConfigSnapshots;
    }
  | { status: "superseded"; applied: false }
  | { status: "session-missing"; applied: false }
  | {
      status: "failed";
      applied: false;
      error: unknown;
      fallback?: SessionExecutionTarget;
    };

interface PendingOperation {
  sequence: number;
  request: SessionTargetTransition;
  operationId: string;
  selectionAtRequest?: SessionTargetSelection;
  targetAtRequest?: SessionExecutionTarget;
  settled: boolean;
  resolve: (outcome: SessionTargetOutcome) => void;
}

interface SessionActor {
  state: SessionTargetSyncState;
  sequence: number;
  running: boolean;
  cancelled: boolean;
  tracksLiveSession: boolean;
  latest?: PendingOperation;
  current?: PendingOperation;
  selection?: SessionTargetSelection;
}

const actors = new Map<string, SessionActor>();
let nextOperationId = 0;

useChatSessionStore.subscribe?.((state) => {
  const liveSessionIds = new Set(state.sessions.map((session) => session.id));
  for (const [sessionId, actor] of actors) {
    if (actor.tracksLiveSession && !liveSessionIds.has(sessionId)) {
      cancelSessionTarget(sessionId);
    }
  }
});

function initialState(sessionId: string): SessionTargetSyncState {
  const session = useChatSessionStore.getState().getSession(sessionId);
  return session?.executionTarget
    ? {
        status: "settled",
        committed: session.executionTarget,
        ...(session.reasoningEffort
          ? {
              metadata: metadataFor(
                session.executionTarget,
                session.reasoningEffort,
              ),
            }
          : {}),
      }
    : { status: "unresolved" };
}

function actorFor(sessionId: string): SessionActor {
  let actor = actors.get(sessionId);
  if (actor) {
    actor.tracksLiveSession ||= Boolean(
      useChatSessionStore.getState().getSession(sessionId),
    );
  } else {
    const tracksLiveSession = Boolean(
      useChatSessionStore.getState().getSession(sessionId),
    );
    actor = {
      state: initialState(sessionId),
      sequence: 0,
      running: false,
      cancelled: false,
      tracksLiveSession,
    };
    actors.set(sessionId, actor);
  }
  return actor;
}

function metadataFor(
  target: SessionExecutionTarget,
  reasoningEffort?: AcpReasoningEffortConfigSnapshot,
): SessionTargetMetadata {
  return { target, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function transition(
  actor: SessionActor,
  event: Parameters<typeof reduceSessionTarget>[1],
) {
  actor.state = reduceSessionTarget(actor.state, event);
}

async function resolveEffectiveTarget(target: SessionExecutionTarget) {
  const selection = gooseServeSelectionFromExecutionTarget(target);
  const repaired = await repairManagedGooseModelSelection(selection, "session");
  const resolved = repaired ?? selection;
  if (!resolved.providerId) {
    throw new Error("Session execution target requires a provider boundary.");
  }
  if (
    target.harnessId === "goose" &&
    repaired &&
    (repaired.providerId !== selection.providerId ||
      repaired.modelId !== selection.modelId)
  ) {
    return normalizeSessionExecutionTarget({
      harnessId: target.harnessId,
      modelProviderId: repaired.providerId,
      modelId: repaired.modelId,
      modelName:
        repaired.modelId === target.modelId
          ? target.modelName
          : repaired.modelId,
    });
  }
  return target;
}

function currentOperation(
  actor: SessionActor,
  operation: PendingOperation,
): boolean {
  return (
    !actor.cancelled &&
    actor.current?.sequence === operation.sequence &&
    actor.latest?.sequence === operation.sequence
  );
}

function settleOperation(
  operation: PendingOperation,
  outcome: SessionTargetOutcome,
): void {
  if (operation.settled) return;
  operation.settled = true;
  operation.resolve(outcome);
}

function resolveSuperseded(
  actor: SessionActor,
  operation: PendingOperation,
): void {
  transition(actor, {
    type: "SUPERSEDED",
    operationId: operation.operationId,
  });
  settleOperation(operation, { status: "superseded", applied: false });
}

async function execute(
  actor: SessionActor,
  operation: PendingOperation,
): Promise<void> {
  const { request, operationId } = operation;
  try {
    const effective = await resolveEffectiveTarget(request.target);
    const liveTarget = useChatSessionStore
      .getState()
      .getSession(request.sessionId)?.executionTarget;
    if (
      !currentOperation(actor, operation) ||
      (actor.selection !== operation.selectionAtRequest &&
        actor.selection?.operationId !== operationId) ||
      (!sameSessionExecutionTarget(liveTarget, operation.targetAtRequest) &&
        !sameSessionExecutionTarget(liveTarget, request.target) &&
        !sameSessionExecutionTarget(liveTarget, effective))
    ) {
      resolveSuperseded(actor, operation);
      return;
    }
    transition(actor, { type: "RESOLVED", operationId, effective });
    const sessionBeforePrepare = useChatSessionStore
      .getState()
      .getSession(request.sessionId);
    if (
      request.requireReasoningEffort &&
      sessionBeforePrepare?.reasoningEffort
    ) {
      if (
        !sameSessionExecutionTarget(
          sessionBeforePrepare.executionTarget,
          effective,
        )
      ) {
        resolveSuperseded(actor, operation);
        return;
      }
      transition(actor, {
        type: "ACKNOWLEDGED",
        operationId,
        target: effective,
        metadata: metadataFor(effective, sessionBeforePrepare.reasoningEffort),
      });
      settleOperation(operation, {
        status: "committed",
        applied: true,
        target: effective,
      });
      return;
    }
    transition(actor, {
      type: "PHASE_CHANGED",
      operationId,
      phase: "applying",
    });
    const selection = gooseServeSelectionFromExecutionTarget(effective);
    if (!selection.providerId) {
      throw new Error("Session execution target requires a provider boundary.");
    }
    const forceConfigRefresh =
      request.requireReasoningEffort &&
      !useChatSessionStore.getState().getSession(request.sessionId)
        ?.reasoningEffort;
    const snapshot = await acpPrepareSession(
      request.sessionId,
      selection.providerId,
      request.prepareWorkingDir ?? request.workingDir,
      {
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        ...(forceConfigRefresh ? { forceConfigRefresh: true } : {}),
        ...(request.operationId || request.requestId
          ? { requestId: operationId }
          : {}),
      },
    );
    if (!currentOperation(actor, operation)) {
      resolveSuperseded(actor, operation);
      return;
    }
    transition(actor, {
      type: "PHASE_CHANGED",
      operationId,
      phase: "awaiting-ack",
    });
    const store = useChatSessionStore.getState();
    const session = store.getSession(request.sessionId);
    if (actor.tracksLiveSession && !session) {
      transition(actor, { type: "SESSION_REMOVED" });
      settleOperation(operation, { status: "session-missing", applied: false });
      return;
    }
    const acknowledged =
      !effective.modelId && snapshot?.model
        ? (materializeSessionExecutionModel(effective, snapshot.model) ??
          effective)
        : effective;
    const legacyIntent = actor.selection
      ? {
          requestId: actor.selection.operationId,
          target: actor.selection.target,
        }
      : undefined;
    const selectionChanged =
      actor.selection !== operation.selectionAtRequest &&
      actor.selection?.operationId !== operationId;
    const coordinatorAcknowledgedTarget =
      actor.state.status === "settled" ? actor.state.committed : undefined;
    const targetIsStillOwned =
      !actor.tracksLiveSession ||
      !session ||
      sameSessionExecutionTarget(
        session.executionTarget,
        operation.targetAtRequest,
      ) ||
      sameSessionExecutionTarget(session.executionTarget, request.target) ||
      sameSessionExecutionTarget(session.executionTarget, effective) ||
      (coordinatorAcknowledgedTarget !== undefined &&
        sameSessionExecutionTarget(
          session.executionTarget,
          coordinatorAcknowledgedTarget,
        ));
    if (
      !targetIsStillOwned ||
      selectionChanged ||
      (request.requireReasoningEffort &&
        session &&
        !sameSessionExecutionTarget(session.executionTarget, request.target)) ||
      (legacyIntent &&
        legacyIntent.requestId !== operationId &&
        !sameSessionExecutionTarget(legacyIntent.target, acknowledged))
    ) {
      resolveSuperseded(actor, operation);
      return;
    }
    const metadata = snapshot?.reasoningEffort
      ? metadataFor(acknowledged, snapshot.reasoningEffort)
      : undefined;
    transition(actor, {
      type: "ACKNOWLEDGED",
      operationId,
      target: acknowledged,
      ...(metadata ? { metadata } : {}),
    });
    if (session) {
      if (!sameSessionExecutionTarget(session.executionTarget, acknowledged)) {
        store.replaceSessionExecutionTarget(request.sessionId, acknowledged);
      }
      if (snapshot?.reasoningEffort) {
        store.patchSession(request.sessionId, {
          reasoningEffort: snapshot.reasoningEffort,
        });
      }
    }
    settleOperation(operation, {
      status: "committed",
      applied: true,
      target: acknowledged,
      ...(!sameSessionExecutionTarget(acknowledged, request.target)
        ? { resolvedTarget: acknowledged }
        : {}),
      configOptionsSnapshot: snapshot,
    });
  } catch (error) {
    if (!currentOperation(actor, operation)) {
      resolveSuperseded(actor, operation);
      return;
    }
    const fallback =
      actor.state.status === "transitioning" ? actor.state.previous : undefined;
    transition(actor, { type: "REJECTED", operationId, error });
    settleOperation(operation, {
      status: "failed",
      applied: false,
      error,
      fallback,
    });
  }
}

async function drain(sessionId: string, actor: SessionActor) {
  if (actor.running) return;
  actor.running = true;
  try {
    while (actor.latest) {
      const operation = actor.latest;
      actor.current = operation;
      await execute(actor, operation);
      if (actor.latest?.sequence === operation.sequence) {
        actor.latest = undefined;
      }
      actor.current = undefined;
    }
  } finally {
    actor.running = false;
    if (actor.latest) void drain(sessionId, actor);
  }
}

function requestSessionTargetTransition(
  request: SessionTargetTransition,
): Promise<SessionTargetOutcome> {
  const actor = actorFor(request.sessionId);
  const selectionAtRequest = actor.selection;
  const targetAtRequest = useChatSessionStore
    .getState()
    .getSession(request.sessionId)?.executionTarget;
  const sequence = ++actor.sequence;
  const operationId =
    request.operationId ?? request.requestId ?? `target-${++nextOperationId}`;
  transition(actor, {
    type: "SELECT",
    operationId,
    origin: request.origin ?? "send",
    desired: request.target,
  });
  const outcome = new Promise<SessionTargetOutcome>((resolve) => {
    const previous = actor.latest;
    if (previous && previous !== actor.current)
      settleOperation(previous, { status: "superseded", applied: false });
    actor.latest = {
      sequence,
      request,
      operationId,
      selectionAtRequest,
      targetAtRequest,
      settled: false,
      resolve,
    };
  });
  void drain(request.sessionId, actor);
  return outcome;
}

export async function transitionSessionTarget(
  request: SessionTargetTransition,
): Promise<SessionTargetOutcome> {
  const outcome = await requestSessionTargetTransition(request);
  if (outcome.status === "failed") throw outcome.error;
  return outcome;
}

export function hydrateSessionTarget(
  sessionId: string,
  target: SessionExecutionTarget,
  reasoningEffort?: AcpReasoningEffortConfigSnapshot,
): boolean {
  const actor = actorFor(sessionId);
  // Uncorrelated hydration is an observation, not a command. It may seed or
  // enrich settled state, but it cannot cancel explicit work already owned by
  // the coordinator.
  if (actor.current || actor.latest || actor.selection) return false;
  const metadata = metadataFor(target, reasoningEffort);
  transition(actor, { type: "HYDRATE", target, metadata });
  const store = useChatSessionStore.getState();
  store.hydrateSessionExecutionTarget(sessionId, target);
  if (reasoningEffort) store.patchSession(sessionId, { reasoningEffort });
  return true;
}

function snapshotContextMatchesTarget(
  target: SessionExecutionTarget | undefined,
  context: AcpSessionConfigSnapshotContext,
): boolean {
  if (context.origin !== "response" || !target || !target.modelId) return false;
  const expected = gooseServeSelectionFromExecutionTarget(target);
  return (
    context.providerId === expected.providerId &&
    context.modelId === expected.modelId
  );
}

function snapshotContextMatchesSelection(
  selection: SessionTargetSelection,
  context: AcpSessionConfigSnapshotContext,
): boolean {
  if (
    context.origin !== "response" ||
    context.requestId !== selection.operationId
  ) {
    return false;
  }
  const expected = gooseServeSelectionFromExecutionTarget(selection.target);
  if (!expected.providerId || context.providerId !== expected.providerId) {
    return false;
  }
  return (
    !selection.target.modelId || context.modelId === selection.target.modelId
  );
}

function rejectModelSnapshot(
  input: {
    sessionId: string;
    snapshot: AcpModelConfigSnapshot;
    context: AcpSessionConfigSnapshotContext;
  },
  session:
    | ReturnType<typeof useChatSessionStore.getState>["sessions"][number]
    | undefined,
  selection: SessionTargetSelection | undefined,
): false {
  console.warn("Dropped divergent ACP model config snapshot", {
    sessionId: input.sessionId.slice(0, 8),
    localModelId: session?.executionTarget?.modelId,
    snapshotModelId: input.snapshot.modelId,
    intentKind: selection
      ? selection.target.modelId
        ? "model"
        : "provider"
      : undefined,
    requestId: input.context.requestId,
    providerId: input.context.providerId,
    modelId: input.context.modelId,
  });
  return false;
}

export function observeSessionTargetModelSnapshot(input: {
  sessionId: string;
  snapshot: AcpModelConfigSnapshot;
  context: AcpSessionConfigSnapshotContext;
}): boolean {
  const actor = actorFor(input.sessionId);
  const store = useChatSessionStore.getState();
  const session = store.getSession(input.sessionId);
  const localTarget = session?.executionTarget;
  const selection = actor.selection;

  let base: SessionExecutionTarget | undefined;
  if (selection) {
    if (
      input.snapshot.modelId !== input.context.modelId ||
      !snapshotContextMatchesSelection(selection, input.context)
    ) {
      return rejectModelSnapshot(input, session, selection);
    }
    base = selection.target;
  } else if (session?.executionTargetSource === "ui") {
    if (
      localTarget?.modelId !== input.snapshot.modelId ||
      (input.context.origin === "response" &&
        !snapshotContextMatchesTarget(localTarget, input.context))
    ) {
      return rejectModelSnapshot(input, session, selection);
    }
    base = localTarget;
  } else {
    base = input.context.providerId
      ? executionTargetFromGooseServeSession({
          providerId: input.context.providerId,
          modelId: input.snapshot.modelId,
          modelName: input.snapshot.modelName,
        })
      : localTarget;
  }

  const target = materializeSessionExecutionModel(base, input.snapshot);
  if (!target) return rejectModelSnapshot(input, session, selection);

  const requestId = input.context.requestId;
  const ownsTransition =
    requestId !== undefined &&
    actor.state.status === "transitioning" &&
    actor.state.operationId === requestId;
  if (ownsTransition) {
    transition(actor, {
      type: "ACKNOWLEDGED",
      operationId: requestId,
      target,
    });
  } else if (!selection) {
    transition(actor, {
      type: "HYDRATE",
      target,
      metadata: metadataFor(target),
    });
  }

  if (session) {
    if (session.executionTargetSource === "ui" || selection) {
      store.replaceSessionExecutionTarget(input.sessionId, target);
    } else {
      store.hydrateSessionExecutionTarget(input.sessionId, target);
    }
  }
  return true;
}

export function observeSessionTargetReasoningSnapshot(input: {
  sessionId: string;
  reasoningEffort: AcpReasoningEffortConfigSnapshot;
  context: AcpSessionConfigSnapshotContext;
}): boolean {
  const actor = actorFor(input.sessionId);
  const session = useChatSessionStore.getState().getSession(input.sessionId);
  const selection = actor.selection;
  const requestIsCurrent =
    input.context.reasoningEffortValue === undefined ||
    session?.reasoningEffort?.currentValue ===
      input.context.reasoningEffortValue;
  const contextIsCurrent = selection
    ? snapshotContextMatchesSelection(selection, input.context)
    : session?.executionTargetSource !== "ui" ||
      snapshotContextMatchesTarget(session.executionTarget, input.context);
  if (!requestIsCurrent || !contextIsCurrent) {
    console.warn("Dropped stale ACP reasoningEffort config snapshot", {
      sessionId: input.sessionId.slice(0, 8),
      intentKind: selection
        ? selection.target.modelId
          ? "model"
          : "provider"
        : undefined,
      origin: input.context.origin,
      providerId: input.context.providerId,
      modelId: input.context.modelId,
      reasoningEffortValue: input.context.reasoningEffortValue,
    });
    return false;
  }

  const target = selection?.target ?? session?.executionTarget;
  if (!target) return false;
  return observeSessionTargetMetadata({
    sessionId: input.sessionId,
    operationId: input.context.requestId,
    target,
    reasoningEffort: input.reasoningEffort,
  });
}

export function observeSessionTargetMetadata(input: {
  sessionId: string;
  operationId?: string;
  target: SessionExecutionTarget;
  reasoningEffort: AcpReasoningEffortConfigSnapshot;
}): boolean {
  const actor = actorFor(input.sessionId);
  if (input.operationId) {
    const ownsTransition =
      actor.state.status === "transitioning" &&
      actor.state.operationId === input.operationId;
    const ownsSelection = actor.selection?.operationId === input.operationId;
    if (!ownsTransition && !ownsSelection) return false;
  } else if (actor.state.status === "transitioning" || actor.selection) {
    return false;
  }
  const expected =
    actor.state.status === "transitioning"
      ? (actor.state.effective ?? actor.state.desired)
      : (actor.selection?.target ??
        useChatSessionStore.getState().getSession(input.sessionId)
          ?.executionTarget);
  if (!sameSessionExecutionTarget(expected, input.target)) return false;
  if (actor.state.status === "transitioning" && input.operationId) {
    transition(actor, {
      type: "METADATA_OBSERVED",
      operationId: input.operationId,
      metadata: metadataFor(input.target, input.reasoningEffort),
    });
  }
  useChatSessionStore.getState().patchSession(input.sessionId, {
    reasoningEffort: input.reasoningEffort,
  });
  return true;
}

export interface SessionTargetSelection {
  operationId: string;
  target: SessionExecutionTarget;
  previousTarget?: SessionExecutionTarget;
  preferenceAgentId?: string;
}

export function recordSessionTargetSelection(input: {
  sessionId: string;
  operationId: string;
  target: SessionExecutionTarget;
  previousTarget?: SessionExecutionTarget;
  preferenceAgentId?: string;
}): void {
  const actor = actorFor(input.sessionId);
  actor.selection = {
    operationId: input.operationId,
    target: normalizeSessionExecutionTarget(input.target),
    previousTarget: input.previousTarget,
    preferenceAgentId: input.preferenceAgentId,
  };
  useChatSessionStore
    .getState()
    .replaceSessionExecutionTarget(input.sessionId, actor.selection.target);
}

export function getSessionTargetSelection(
  sessionId: string,
): SessionTargetSelection | undefined {
  return actorFor(sessionId).selection;
}

export function clearSessionTargetSelection(
  sessionId: string,
  operationId?: string,
): boolean {
  const actor = actors.get(sessionId);
  if (!actor?.selection) return false;
  if (operationId && actor.selection.operationId !== operationId) return false;
  actor.selection = undefined;
  return true;
}

export function transferSessionTargetOwnership(
  fromSessionId: string,
  toSessionId: string,
): void {
  const source = actors.get(fromSessionId);
  if (!source) return;
  actors.delete(fromSessionId);
  source.tracksLiveSession = true;
  actors.set(toSessionId, source);
}

export function getSessionTargetState(
  sessionId: string,
): SessionTargetSyncState {
  return actorFor(sessionId).state;
}

export function cancelSessionTarget(sessionId: string): void {
  const actor = actors.get(sessionId);
  if (!actor) return;
  actor.cancelled = true;
  transition(actor, { type: "SESSION_REMOVED" });
  const pending = new Set(
    [actor.current, actor.latest].filter(
      (operation): operation is PendingOperation => operation !== undefined,
    ),
  );
  for (const operation of pending) {
    settleOperation(operation, { status: "session-missing", applied: false });
  }
  actor.latest = undefined;
  actor.selection = undefined;
  actors.delete(sessionId);
}

export function resetSessionTargetCoordinatorsForTests(): void {
  actors.clear();
  nextOperationId = 0;
}
