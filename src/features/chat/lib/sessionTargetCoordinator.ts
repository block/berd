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
  dispatchToken?: symbol;
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
  /**
   * A user selection made while dispatch owns the live target. It remains
   * visible to the picker request that must apply it, but cannot affect the
   * leased target until dispatch releases.
   */
  deferredSelection?: SessionTargetSelection;
  deferredTargetMutation?: {
    kind: "target";
    target?: SessionExecutionTarget;
    source: "ui" | "acp";
    reasoningEffort?: AcpReasoningEffortConfigSnapshot;
  };
  dispatch?: {
    token: symbol;
    target: SessionExecutionTarget;
    source?: "ui" | "acp";
    reasoningEffort?: AcpReasoningEffortConfigSnapshot;
    release: () => void;
  };
  dispatchReleased?: Promise<void>;
  dispatchReleaseListeners: Set<() => void>;
}

const actors = new Map<string, SessionActor>();
let nextOperationId = 0;
let restoringLeasedTarget = false;

useChatSessionStore.subscribe?.((state) => {
  if (!restoringLeasedTarget) {
    for (const [sessionId, actor] of actors) {
      const dispatch = actor.dispatch;
      if (!dispatch) continue;
      const session = state.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      const observed = session?.executionTarget;
      const matchesLease =
        sameSessionExecutionTarget(observed, dispatch.target) ||
        (dispatch.target.modelId === undefined &&
          observed?.harnessId === dispatch.target.harnessId &&
          observed.modelProviderId === dispatch.target.modelProviderId);
      if (matchesLease) continue;

      actor.deferredTargetMutation = {
        kind: "target",
        target: observed,
        source: session?.executionTargetSource ?? "acp",
        ...(session?.reasoningEffort
          ? { reasoningEffort: session.reasoningEffort }
          : {}),
      };
      restoringLeasedTarget = true;
      try {
        useChatSessionStore.setState((current) => ({
          sessions: current.sessions.map((candidate) =>
            candidate.id === sessionId
              ? {
                  ...candidate,
                  executionTarget: dispatch.target,
                  executionTargetSource: dispatch.source,
                  reasoningEffort: dispatch.reasoningEffort,
                }
              : candidate,
          ),
        }));
      } finally {
        restoringLeasedTarget = false;
      }
    }
  }

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
      dispatchReleaseListeners: new Set(),
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

function notifyDispatchReleaseListeners(actor: SessionActor): void {
  if (actor.dispatch || actor.running || actor.latest) return;
  const releaseListeners = [...actor.dispatchReleaseListeners];
  actor.dispatchReleaseListeners.clear();
  for (const listener of releaseListeners) listener();
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
    if (actor.latest) {
      void drain(sessionId, actor);
    } else {
      notifyDispatchReleaseListeners(actor);
    }
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

export interface SessionDispatchTargetLease {
  target: SessionExecutionTarget;
  token: symbol;
  release: () => void;
}

type SessionDispatchTargetNonAcquired = {
  target?: undefined;
  token?: undefined;
  release?: undefined;
};

export interface SessionDispatchReleaseWaiter {
  wait: (listener: () => void) => () => void;
  cancel: () => void;
}

function createDispatchReleaseWaiter(
  actor: SessionActor,
): SessionDispatchReleaseWaiter {
  let listener: (() => void) | undefined;
  let cancelled = false;
  let released = false;
  let scheduled = false;

  const schedule = () => {
    if (scheduled || cancelled || !released || !listener) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (cancelled || !released || !listener) return;
      const pending = listener;
      listener = undefined;
      cancelled = true;
      pending();
    });
  };
  const releasedListener = () => {
    if (cancelled) return;
    released = true;
    schedule();
  };
  actor.dispatchReleaseListeners.add(releasedListener);
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    listener = undefined;
    actor.dispatchReleaseListeners.delete(releasedListener);
  };
  return {
    wait: (nextListener) => {
      if (cancelled) return () => {};
      listener = nextListener;
      schedule();
      return cancel;
    },
    cancel,
  };
}

export type SessionDispatchTargetAcquisition =
  | ({ status: "acquired" } & SessionDispatchTargetLease)
  | ({
      status: "contended";
      waiter: SessionDispatchReleaseWaiter;
    } & SessionDispatchTargetNonAcquired)
  | ({ status: "unresolved" } & SessionDispatchTargetNonAcquired)
  | ({ status: "session-missing" } & SessionDispatchTargetNonAcquired);

export function acquireSessionDispatchTarget(
  sessionId: string,
  targetOverride?: SessionExecutionTarget,
): SessionDispatchTargetAcquisition {
  const actor = actorFor(sessionId);
  if (actor.dispatch) {
    return {
      status: "contended",
      waiter: createDispatchReleaseWaiter(actor),
    };
  }
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) return { status: "session-missing" };
  const target = targetOverride ?? session.executionTarget;
  if (!target) return { status: "unresolved" };
  if (
    targetOverride &&
    !sameSessionExecutionTarget(session.executionTarget, targetOverride)
  ) {
    actor.deferredTargetMutation = {
      kind: "target",
      target: session.executionTarget,
      source: session.executionTargetSource ?? "acp",
      ...(session.reasoningEffort
        ? { reasoningEffort: session.reasoningEffort }
        : {}),
    };
  }
  const token = Symbol(`dispatch:${sessionId}`);
  let releaseGate!: () => void;
  actor.dispatchReleased = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const release = () => {
    if (actor.dispatch?.token !== token) return;
    actor.dispatch = undefined;
    actor.dispatchReleased = undefined;
    const deferredSelection = actor.deferredSelection;
    actor.deferredSelection = undefined;
    const deferredMutation = actor.deferredTargetMutation;
    actor.deferredTargetMutation = undefined;
    if (deferredSelection) {
      // User intent wins over uncorrelated external observations. Keep the
      // store on the successfully prepared lease target until the picker
      // transition waiting behind this release prepares and publishes B.
      actor.selection = deferredSelection;
    } else if (deferredMutation) {
      const store = useChatSessionStore.getState();
      const target = deferredMutation.target;
      if (target) {
        transition(actor, {
          type: "HYDRATE",
          target,
          metadata: metadataFor(target, deferredMutation.reasoningEffort),
        });
      } else {
        transition(actor, { type: "SESSION_REMOVED" });
      }
      if (deferredMutation.source === "ui") {
        store.replaceSessionExecutionTarget(sessionId, target);
      } else {
        const normalizedTarget = target
          ? normalizeSessionExecutionTarget(target)
          : undefined;
        useChatSessionStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  executionTarget: normalizedTarget,
                  executionTargetSource: "acp" as const,
                  reasoningEffort: deferredMutation.reasoningEffort,
                }
              : session,
          ),
        }));
      }
      if (
        deferredMutation.source === "ui" &&
        deferredMutation.reasoningEffort
      ) {
        store.patchSession(sessionId, {
          reasoningEffort: deferredMutation.reasoningEffort,
        });
      }
    }
    releaseGate();
    if (actor.latest) {
      void drain(sessionId, actor);
    } else {
      queueMicrotask(() => notifyDispatchReleaseListeners(actor));
    }
  };
  actor.dispatch = {
    token,
    target,
    source: session.executionTargetSource,
    reasoningEffort: session.reasoningEffort,
    release,
  };
  if (
    targetOverride &&
    !sameSessionExecutionTarget(session.executionTarget, targetOverride)
  ) {
    restoringLeasedTarget = true;
    try {
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId
            ? {
                ...candidate,
                executionTarget: targetOverride,
                executionTargetSource: actor.dispatch?.source,
                reasoningEffort: actor.dispatch?.reasoningEffort,
              }
            : candidate,
        ),
      }));
    } finally {
      restoringLeasedTarget = false;
    }
  }
  return {
    status: "acquired",
    target,
    token,
    release,
  };
}

export function onSessionDispatchReleased(
  sessionId: string,
  listener: () => void,
): (() => void) | null {
  const actor = actors.get(sessionId);
  if (!actor?.dispatch) return null;
  actor.dispatchReleaseListeners.add(listener);
  return () => actor.dispatchReleaseListeners.delete(listener);
}

export function getSessionDispatchTarget(
  sessionId: string,
  dispatchToken?: symbol,
): SessionExecutionTarget | undefined {
  const dispatch = actors.get(sessionId)?.dispatch;
  if (!dispatch || (dispatchToken && dispatch.token !== dispatchToken)) {
    return undefined;
  }
  return dispatch.target;
}

export async function transitionSessionTarget(
  request: SessionTargetTransition,
): Promise<SessionTargetOutcome> {
  const actor = actorFor(request.sessionId);
  const activeDispatch = actor.dispatch;
  if (activeDispatch && request.dispatchToken !== activeDispatch.token) {
    await actor.dispatchReleased;
  }
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
  if (actor.dispatch) {
    const dispatchTarget = actor.dispatch.target;
    const normalizedTarget = normalizeSessionExecutionTarget(target);
    const matchesDispatch =
      sameSessionExecutionTarget(normalizedTarget, dispatchTarget) ||
      (dispatchTarget.modelId === undefined &&
        normalizedTarget.harnessId === dispatchTarget.harnessId &&
        normalizedTarget.modelProviderId === dispatchTarget.modelProviderId);
    if (matchesDispatch) {
      const store = useChatSessionStore.getState();
      if (!sameSessionExecutionTarget(normalizedTarget, dispatchTarget)) {
        store.hydrateSessionExecutionTarget(sessionId, normalizedTarget);
      }
      if (reasoningEffort) {
        store.patchSession(sessionId, {
          reasoningEffort,
        });
      }
      return true;
    }
    actor.deferredTargetMutation = {
      kind: "target",
      target: normalizedTarget,
      source: "acp",
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    return false;
  }
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

function publishObservedTarget(
  sessionId: string,
  target: SessionExecutionTarget,
  source: "ui" | "acp",
  reasoningEffort?: AcpReasoningEffortConfigSnapshot,
): void {
  const normalizedTarget = normalizeSessionExecutionTarget(target);
  useChatSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const identityChanged = !sameSessionExecutionTarget(
        session.executionTarget,
        normalizedTarget,
      );
      return {
        ...session,
        executionTarget: normalizedTarget,
        executionTargetSource: source,
        ...(reasoningEffort
          ? { reasoningEffort }
          : identityChanged
            ? { reasoningEffort: undefined }
            : {}),
      };
    }),
  }));
}

export function observeSessionTargetModelSnapshot(input: {
  sessionId: string;
  snapshot: AcpModelConfigSnapshot;
  reasoningEffort?: AcpReasoningEffortConfigSnapshot;
  context: AcpSessionConfigSnapshotContext;
}): boolean {
  const actor = actorFor(input.sessionId);
  const store = useChatSessionStore.getState();
  const session = store.getSession(input.sessionId);
  const localTarget = session?.executionTarget;
  const selection = actor.selection;
  const requestId = input.context.requestId;
  const ownsTransition =
    requestId !== undefined &&
    actor.state.status === "transitioning" &&
    actor.state.operationId === requestId;
  if (actor.dispatch) {
    const dispatchTarget = actor.dispatch.target;
    const observedBase = input.context.providerId
      ? executionTargetFromGooseServeSession({
          providerId: input.context.providerId,
          modelId: input.snapshot.modelId,
          modelName: input.snapshot.modelName,
        })
      : dispatchTarget;
    const observedTarget = materializeSessionExecutionModel(
      observedBase,
      input.snapshot,
    );
    if (!observedTarget) {
      return rejectModelSnapshot(input, session, selection);
    }
    const matchesDispatch =
      sameSessionExecutionTarget(observedTarget, dispatchTarget) ||
      (dispatchTarget.modelId === undefined &&
        observedTarget.harnessId === dispatchTarget.harnessId &&
        observedTarget.modelProviderId === dispatchTarget.modelProviderId);
    if (!matchesDispatch) {
      actor.deferredTargetMutation = {
        kind: "target",
        target: observedTarget,
        source: "acp",
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
      };
      return false;
    }
    if (!ownsTransition) {
      const pairedReasoningIsCurrent =
        input.reasoningEffort !== undefined &&
        session !== undefined &&
        (input.context.reasoningEffortValue === undefined ||
          session.reasoningEffort?.currentValue ===
            input.context.reasoningEffortValue) &&
        (session.executionTargetSource !== "ui" ||
          snapshotContextMatchesTarget(session.executionTarget, input.context));
      if (session) {
        publishObservedTarget(
          input.sessionId,
          observedTarget,
          session.executionTargetSource === "ui" ? "ui" : "acp",
          pairedReasoningIsCurrent ? input.reasoningEffort : undefined,
        );
      }
      return true;
    }
  }

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
  const pairedReasoningIsCurrent =
    input.reasoningEffort !== undefined &&
    (input.context.reasoningEffortValue === undefined ||
      session?.reasoningEffort?.currentValue ===
        input.context.reasoningEffortValue) &&
    (selection
      ? snapshotContextMatchesSelection(selection, input.context)
      : session?.executionTargetSource !== "ui" ||
        snapshotContextMatchesTarget(session.executionTarget, input.context));
  const pairedReasoning = pairedReasoningIsCurrent
    ? input.reasoningEffort
    : undefined;

  if (ownsTransition) {
    transition(actor, {
      type: "ACKNOWLEDGED",
      operationId: requestId,
      target,
      ...(pairedReasoning
        ? { metadata: metadataFor(target, pairedReasoning) }
        : {}),
    });
  } else if (!selection) {
    transition(actor, {
      type: "HYDRATE",
      target,
      metadata: metadataFor(target, pairedReasoning),
    });
  }

  if (session) {
    if (input.reasoningEffort && !pairedReasoningIsCurrent) {
      console.warn("Dropped stale ACP reasoningEffort config snapshot", {
        sessionId: input.sessionId.slice(0, 8),
        origin: input.context.origin,
        providerId: input.context.providerId,
        modelId: input.context.modelId,
        reasoningEffortValue: input.context.reasoningEffortValue,
      });
    }
    publishObservedTarget(
      input.sessionId,
      target,
      session.executionTargetSource === "ui" || selection ? "ui" : "acp",
      pairedReasoning,
    );
  }
  return true;
}

export function observeSessionTargetConfigSnapshots(input: {
  sessionId: string;
  snapshots: AcpSessionConfigSnapshots;
  context: AcpSessionConfigSnapshotContext;
}): void {
  const { model, reasoningEffort } = input.snapshots;
  if (model) {
    observeSessionTargetModelSnapshot({
      sessionId: input.sessionId,
      snapshot: model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      context: input.context,
    });
    return;
  }
  if (reasoningEffort) {
    observeSessionTargetReasoningSnapshot({
      sessionId: input.sessionId,
      reasoningEffort,
      context: input.context,
    });
  }
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
  const selection = {
    operationId: input.operationId,
    target: normalizeSessionExecutionTarget(input.target),
    previousTarget: input.previousTarget,
    preferenceAgentId: input.preferenceAgentId,
  };
  if (actor.dispatch) {
    actor.deferredSelection = selection;
    return;
  }
  actor.selection = selection;
  useChatSessionStore
    .getState()
    .replaceSessionExecutionTarget(input.sessionId, selection.target);
}

export function replaceSessionTargetAfterDispatch(
  sessionId: string,
  target: SessionExecutionTarget | undefined,
): void {
  const actor = actorFor(sessionId);
  if (actor.dispatch) {
    actor.deferredTargetMutation = {
      kind: "target",
      target,
      source: "ui",
    };
    return;
  }
  useChatSessionStore
    .getState()
    .replaceSessionExecutionTarget(sessionId, target);
}

export function getSessionTargetSelection(
  sessionId: string,
): SessionTargetSelection | undefined {
  const actor = actorFor(sessionId);
  return actor.deferredSelection ?? actor.selection;
}

export function clearSessionTargetSelection(
  sessionId: string,
  operationId?: string,
): boolean {
  const actor = actors.get(sessionId);
  if (!actor) return false;
  if (actor.deferredSelection) {
    if (operationId && actor.deferredSelection.operationId !== operationId) {
      return false;
    }
    actor.deferredSelection = undefined;
    return true;
  }
  if (!actor.selection) return false;
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
  const destination = actors.get(toSessionId);
  if (destination) {
    destination.selection ??= source.selection;
    destination.deferredSelection ??= source.deferredSelection;
    destination.deferredTargetMutation ??= source.deferredTargetMutation;
    source.cancelled = true;
    const pending = new Set(
      [source.current, source.latest].filter(
        (operation): operation is PendingOperation => operation !== undefined,
      ),
    );
    for (const operation of pending) {
      settleOperation(operation, { status: "superseded", applied: false });
    }
    source.current = undefined;
    source.latest = undefined;
    source.dispatch?.release();
    return;
  }
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
  actor.deferredSelection = undefined;
  actor.deferredTargetMutation = undefined;
  actor.dispatch?.release();
  actors.delete(sessionId);
}

export function resetSessionTargetCoordinatorsForTests(): void {
  actors.clear();
  nextOperationId = 0;
}
