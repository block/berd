import * as acpApi from "./acpApi";
import { invalidateClientConnection } from "./acpConnection";
import {
  readSessionExecutionConfigSnapshot,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import { perfLog } from "@/shared/lib/perfLog";
import {
  logReasoningEffortInfo,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import {
  getModelInventoryProofRevision,
  isModelSelectionAllowedByCachedInventory,
} from "@/features/providers/stores/providerModelCacheStore";

export interface AcpSessionExecutionSelection {
  providerId: string;
  /** Last model this window observed ACP acknowledge successfully. */
  modelId?: string;
  /** Shared inventory proof already known when ACP acknowledged this selection. */
  acknowledgedProofRevision?: number;
}

interface PreparedSession {
  workingDir: string;
  executionSelection?: AcpSessionExecutionSelection;
}

interface SessionConfigMutationOptions {
  forceConfigRefresh?: boolean;
  requestId?: string;
}

const SESSION_MUTATION_TIMEOUT_MS = 60_000;

interface SessionMutationQueue {
  latestSequence: number;
  tail: Promise<void>;
  /** Configuration intent awaiting async preflight before it can enqueue. */
  pendingSupersession?: {
    sequence: number;
    previousSequence: number;
    settled: Promise<void>;
    resolve: () => void;
  };
}

/** Opaque ownership of a configuration intent that is awaiting preflight. */
export interface SessionMutationSupersession {
  readonly sequence: number;
  clear(): void;
}

const prepared = new Map<string, PreparedSession>();
const mutationQueues = new Map<string, SessionMutationQueue>();
let nextMutationSequence = 1;

function scheduleQueueCleanup(
  sessionId: string,
  queue: SessionMutationQueue,
): void {
  const tail = queue.tail;
  void tail.then(() => {
    if (
      mutationQueues.get(sessionId) === queue &&
      queue.tail === tail &&
      queue.pendingSupersession === undefined
    ) {
      mutationQueues.delete(sessionId);
    }
  });
}

function clonePreparedSession(
  entry: PreparedSession | undefined,
): PreparedSession | undefined {
  return entry
    ? {
        ...entry,
        executionSelection: entry.executionSelection
          ? { ...entry.executionSelection }
          : undefined,
      }
    : undefined;
}

function replaceExecutionSelection(
  entry: PreparedSession,
  providerId: string,
  modelId?: string,
): void {
  entry.executionSelection = {
    providerId,
    ...(modelId ? { modelId } : {}),
    acknowledgedProofRevision: getModelInventoryProofRevision(providerId),
  };
}

async function runBoundedSessionMutation<T>(
  sessionId: string,
  mutation: Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;
  try {
    return await Promise.race([
      mutation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeOut = true;
          reject(
            new Error(
              `ACP operation timed out for session ${sessionId.slice(0, 8)}. Reconnect and retry.`,
            ),
          );
        }, SESSION_MUTATION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (didTimeOut) {
      prepared.delete(sessionId);
      await invalidateClientConnection().catch((invalidationError) => {
        console.error(
          "Failed to invalidate timed-out ACP connection:",
          invalidationError,
        );
      });
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function serializeSessionMutation<T>(
  sessionId: string,
  mutation: (
    isLatest: () => boolean,
    sequence: number,
    queue: SessionMutationQueue,
  ) => Promise<T>,
  bounded = true,
): Promise<T> {
  let queue = mutationQueues.get(sessionId);
  if (!queue) {
    queue = { latestSequence: 0, tail: Promise.resolve() };
    mutationQueues.set(sessionId, queue);
  }

  const sequence = nextMutationSequence++;
  queue.latestSequence = sequence;
  const execute = () =>
    mutation(
      () =>
        queue?.pendingSupersession === undefined &&
        queue?.latestSequence === sequence,
      sequence,
      queue,
    );
  const result = queue.tail.then(() =>
    bounded ? runBoundedSessionMutation(sessionId, execute()) : execute(),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queue.tail = tail;
  scheduleQueueCleanup(sessionId, queue);
  return result;
}

function consumeSessionSupersession(
  sessionId: string,
  supersession: SessionMutationSupersession | undefined,
): boolean {
  if (!supersession) return true;
  const queue = mutationQueues.get(sessionId);
  if (queue?.pendingSupersession?.sequence !== supersession.sequence) {
    return false;
  }
  const pending = queue.pendingSupersession;
  queue.pendingSupersession = undefined;
  pending.resolve();
  scheduleQueueCleanup(sessionId, queue);
  return true;
}

export function supersedeSessionMutation(
  sessionId: string,
): SessionMutationSupersession {
  let queue = mutationQueues.get(sessionId);
  if (!queue) {
    queue = { latestSequence: 0, tail: Promise.resolve() };
    mutationQueues.set(sessionId, queue);
  }
  // Retain preflight intent before its authoritative I/O completes so a load
  // cannot publish a snapshot that predates the requested configuration.
  const sequence = nextMutationSequence++;
  const previousSequence =
    queue.pendingSupersession?.previousSequence ?? queue.latestSequence;
  queue.pendingSupersession?.resolve();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  queue.latestSequence = sequence;
  queue.pendingSupersession = {
    sequence,
    previousSequence,
    settled,
    resolve: resolveSettled,
  };
  scheduleQueueCleanup(sessionId, queue);

  return {
    sequence,
    clear() {
      if (queue?.pendingSupersession?.sequence !== sequence) return;
      const pending = queue.pendingSupersession;
      queue.pendingSupersession = undefined;
      if (queue.latestSequence === sequence) {
        queue.latestSequence = pending.previousSequence;
      }
      pending.resolve();
      scheduleQueueCleanup(sessionId, queue);
    },
  };
}

export async function prepareSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: SessionConfigMutationOptions = {},
  supersession?: SessionMutationSupersession,
): Promise<AcpSessionConfigSnapshots | undefined> {
  if (!consumeSessionSupersession(sessionId, supersession)) return;
  const snapshots = await serializeSessionMutation(sessionId, () =>
    prepareSessionNow(sessionId, providerId, workingDir, options),
  );
  return snapshots;
}

async function prepareSessionNow(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: SessionConfigMutationOptions,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const existing = prepared.get(sessionId);
  if (existing) {
    const tReuse = performance.now();
    let changed = false;
    let snapshots: AcpSessionConfigSnapshots | undefined;
    const existingProviderId = existing.executionSelection?.providerId;
    logReasoningEffortInfo("prepareSession reuse", {
      sessionId: shortLogId(sessionId),
      existingProviderId: existingProviderId ?? null,
      requestedProviderId: providerId,
      providerChanged: existingProviderId !== providerId,
      workingDirChanged: existing.workingDir !== workingDir,
      cachedModelId: existing.executionSelection?.modelId ?? null,
    });
    if (existing.workingDir !== workingDir) {
      await acpApi.updateWorkingDir(sessionId, workingDir);
      existing.workingDir = workingDir;
      changed = true;
    }
    if (existingProviderId !== providerId || options.forceConfigRefresh) {
      const tProv = performance.now();
      try {
        snapshots = await acpApi.setProvider(sessionId, providerId, {
          requestId: options.requestId,
        });
      } catch (error) {
        // Goose can apply the provider and then fail while building the
        // response snapshot. The complete backend pair is unknown until the
        // UI selection is prepared again.
        existing.executionSelection = undefined;
        throw error;
      }
      perfLog(
        `[perf:prepare] ${sid} reuse setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
      );
      replaceExecutionSelection(
        existing,
        providerId,
        normalizeConcreteModelId(snapshots?.model?.modelId),
      );
      changed = true;
    }
    perfLog(
      `[perf:prepare] ${sid} reuse existing session (updates=${changed}) in ${(performance.now() - tReuse).toFixed(1)}ms`,
    );
    if (!snapshots && existing.executionSelection?.modelId) {
      return {
        model: {
          modelId: existing.executionSelection.modelId,
          modelName: existing.executionSelection.modelId,
        },
        reasoningEffort: null,
      };
    }
    return snapshots;
  }

  const tLoad = performance.now();
  logReasoningEffortInfo("prepareSession load", {
    sessionId: shortLogId(sessionId),
    providerId,
  });
  await acpApi.loadSession(sessionId, workingDir);
  perfLog(
    `[perf:prepare] ${sid} registry loadSession ok in ${(performance.now() - tLoad).toFixed(1)}ms`,
  );

  const tProv = performance.now();
  const snapshots = await acpApi.setProvider(sessionId, providerId, {
    requestId: options.requestId,
  });
  perfLog(
    `[perf:prepare] ${sid} registry setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
  );

  const acknowledgedModelId = normalizeConcreteModelId(
    snapshots?.model?.modelId,
  );
  const entry = {
    workingDir,
    executionSelection: {
      providerId,
      ...(acknowledgedModelId ? { modelId: acknowledgedModelId } : {}),
      acknowledgedProofRevision: getModelInventoryProofRevision(providerId),
    },
  };
  prepared.set(sessionId, entry);

  return snapshots;
}

/**
 * Apply a model to a session, skipping the wire call when this window already
 * applied the same model.
 */
export async function applySessionModel(
  sessionId: string,
  modelId: string,
  options: SessionConfigMutationOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  const concreteModelId = normalizeConcreteModelId(modelId);
  if (!concreteModelId) {
    throw new Error(`Invalid model id: ${modelId}`);
  }
  return serializeSessionMutation(sessionId, () =>
    applySessionModelNow(sessionId, concreteModelId, options),
  );
}

async function applySessionModelNow(
  sessionId: string,
  modelId: string,
  options: SessionConfigMutationOptions,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const entry = prepared.get(sessionId);
  const executionSelection = entry?.executionSelection;
  if (!entry || !executionSelection) {
    throw new Error(
      "Session not prepared. Prepare the provider before its model.",
    );
  }
  if (executionSelection.modelId === modelId && !options.forceConfigRefresh) {
    logReasoningEffortInfo("applySessionModel skipped unchanged", {
      sessionId: shortLogId(sessionId),
      modelId,
      providerId: executionSelection.providerId,
    });
    perfLog(`[perf:prepare] ${sid} skip setModel(${modelId}) — unchanged`);
    return;
  }

  let snapshots: AcpSessionConfigSnapshots | undefined;
  try {
    logReasoningEffortInfo("applySessionModel start", {
      sessionId: shortLogId(sessionId),
      modelId,
      providerId: executionSelection.providerId,
    });
    snapshots = await acpApi.setModel(sessionId, modelId, {
      providerId: executionSelection.providerId,
      requestId: options.requestId,
    });
  } catch (error) {
    // Drop the cached value so the next attempt retries over the wire.
    replaceExecutionSelection(entry, executionSelection.providerId);
    throw error;
  }

  const acknowledgedModelId = snapshots?.model
    ? normalizeConcreteModelId(snapshots.model.modelId)
    : modelId;
  replaceExecutionSelection(
    entry,
    executionSelection.providerId,
    acknowledgedModelId,
  );
  if (acknowledgedModelId !== modelId) {
    throw new Error(
      `ACP acknowledged model ${acknowledgedModelId ?? "<none>"} instead of requested model ${modelId}`,
    );
  }
  logReasoningEffortInfo("applySessionModel complete", {
    sessionId: shortLogId(sessionId),
    modelId,
    providerId: executionSelection.providerId,
    hasReasoningEffortSnapshot: Boolean(snapshots?.reasoningEffort),
  });
  return snapshots;
}

export async function configureSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  modelId?: string,
  options: SessionConfigMutationOptions = {},
  supersession?: SessionMutationSupersession,
): Promise<AcpSessionConfigSnapshots | undefined> {
  const concreteModelId = normalizeConcreteModelId(modelId);
  if (modelId && !concreteModelId) {
    throw new Error(`Invalid model id: ${modelId}`);
  }
  if (!consumeSessionSupersession(sessionId, supersession)) return;
  const snapshots = await serializeSessionMutation(sessionId, async () => {
    let snapshots = await prepareSessionNow(
      sessionId,
      providerId,
      workingDir,
      concreteModelId ? {} : options,
    );
    if (concreteModelId) {
      const modelSnapshots = await applySessionModelNow(
        sessionId,
        concreteModelId,
        options,
      );
      snapshots = modelSnapshots ?? {
        model: { modelId: concreteModelId, modelName: concreteModelId },
        reasoningEffort: null,
      };
    }
    return snapshots;
  });
  return snapshots;
}

export function applySessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  return serializeSessionMutation(sessionId, () =>
    acpApi.setSessionConfigOption(sessionId, configId, value, context),
  );
}

export function isSessionPrepared(sessionId: string): boolean {
  return Boolean(prepared.get(sessionId)?.executionSelection);
}

/** Provider id the session is currently prepared against, if known. */
export function getPreparedProviderId(sessionId: string): string | undefined {
  return prepared.get(sessionId)?.executionSelection?.providerId;
}

/** Return the complete backend execution selection observed by this window. */
export function requireSessionInvocationSelection(
  sessionId: string,
): AcpSessionExecutionSelection & { modelId: string } {
  const selection = prepared.get(sessionId)?.executionSelection;
  if (!selection?.providerId || !selection.modelId) {
    throw new Error(
      "Session requires a configured provider and model before prompting. Re-prepare the session after completing provider setup.",
    );
  }
  if (
    !isModelSelectionAllowedByCachedInventory(
      selection.providerId,
      selection.modelId,
      selection.acknowledgedProofRevision,
    )
  ) {
    throw new Error(
      `Session model ${selection.modelId} is no longer supported by provider ${selection.providerId}. Re-prepare the session before prompting.`,
    );
  }
  const { acknowledgedProofRevision: _, ...invocationSelection } = selection;
  return { ...invocationSelection, modelId: selection.modelId };
}

/** Run prompt setup and transport without allowing session config to interleave. */
export async function runPreparedSessionPrompt<T>(
  sessionId: string,
  prompt: (providerId: string) => Promise<T>,
): Promise<T> {
  let pending = mutationQueues.get(sessionId)?.pendingSupersession;
  while (pending) {
    await pending.settled;
    pending = mutationQueues.get(sessionId)?.pendingSupersession;
  }
  return serializeSessionMutation(
    sessionId,
    () => prompt(requireSessionInvocationSelection(sessionId).providerId),
    false,
  );
}

export async function loadSession(
  sessionId: string,
  workingDir: string,
): Promise<{
  response: Awaited<ReturnType<typeof acpApi.loadSession>>;
  isCurrent: boolean;
  deferredCurrent?: Promise<boolean>;
  executionSelection?: AcpSessionExecutionSelection;
}> {
  return serializeSessionMutation(
    sessionId,
    async (isLatest, _sequence, queue) => {
      const response = await acpApi.loadSession(sessionId, workingDir);
      const pendingAtResponse = queue.pendingSupersession;
      const isCurrentResult = isLatest();
      const deferredCurrent = pendingAtResponse
        ? (async () => {
            let pending: SessionMutationQueue["pendingSupersession"] =
              pendingAtResponse;
            while (pending) {
              await pending.settled;
              pending = queue.pendingSupersession;
            }
            return isLatest();
          })()
        : undefined;
      const executionSnapshot = readSessionExecutionConfigSnapshot(response);
      prepared.set(sessionId, {
        workingDir,
        executionSelection: executionSnapshot ?? undefined,
      });
      return {
        response,
        isCurrent: isCurrentResult,
        ...(deferredCurrent ? { deferredCurrent } : {}),
        executionSelection: executionSnapshot ?? undefined,
      };
    },
    false,
  );
}

export function registerPreparedSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  modelId?: string,
): () => void {
  const previousEntry = clonePreparedSession(prepared.get(sessionId));
  const acknowledgedModelId = normalizeConcreteModelId(modelId);
  const entry: PreparedSession = {
    workingDir,
    executionSelection: {
      providerId,
      ...(acknowledgedModelId ? { modelId: acknowledgedModelId } : {}),
      acknowledgedProofRevision: getModelInventoryProofRevision(providerId),
    },
  };

  prepared.set(sessionId, entry);
  logReasoningEffortInfo("registerPreparedSession", {
    sessionId: shortLogId(sessionId),
    providerId,
    hadPreviousEntry: Boolean(previousEntry),
    previousProviderId: previousEntry?.executionSelection?.providerId ?? null,
    previousModelId: previousEntry?.executionSelection?.modelId ?? null,
  });

  return () => {
    if (prepared.get(sessionId) !== entry) {
      return;
    }
    prepared.delete(sessionId);
    if (previousEntry) {
      prepared.set(sessionId, previousEntry);
    }
  };
}
