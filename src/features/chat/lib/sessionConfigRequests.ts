import { acpPrepareSession, acpSetModel } from "@/shared/api/acp";
import type { AcpSessionConfigSnapshots } from "@/shared/api/acpSessionConfigSnapshots";
import {
  repairManagedGooseModelSelection,
  type ManagedModelRepairSource,
} from "@/features/providers/lib/managedModelSelectionRepair";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

export interface SessionConfigRequest {
  sessionId: string;
  providerId: string;
  workingDir: string;
  modelId?: string | null;
  forceConfigRefresh?: boolean;
  repairSource?: ManagedModelRepairSource;
  modelSelectionRequestId?: string;
}

export interface SessionConfigResult {
  applied: boolean;
  configOptionsSnapshot?: AcpSessionConfigSnapshots;
  resolvedProviderId?: string;
  resolvedModelId?: string;
  repaired?: boolean;
}

interface QueuedSessionConfigRequest extends SessionConfigRequest {
  sequence: number;
}

interface SessionConfigWaiter {
  sequence: number;
  request: QueuedSessionConfigRequest;
  resolve: (result: SessionConfigResult) => void;
  reject: (error: unknown) => void;
}

interface SessionConfigQueue {
  latest: QueuedSessionConfigRequest | null;
  nextSequence: number;
  running: boolean;
  waiters: SessionConfigWaiter[];
}

const queues = new Map<string, SessionConfigQueue>();

function getQueue(sessionId: string): SessionConfigQueue {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = {
      latest: null,
      nextSequence: 0,
      running: false,
      waiters: [],
    };
    queues.set(sessionId, queue);
  }
  return queue;
}

function sameSessionConfig(
  a: SessionConfigRequest,
  b: SessionConfigRequest,
): boolean {
  return (
    a.providerId === b.providerId &&
    a.workingDir === b.workingDir &&
    (a.modelId ?? null) === (b.modelId ?? null)
  );
}

function settleFailedWaiters(
  queue: SessionConfigQueue,
  sequence: number,
  error: unknown,
) {
  const remaining: SessionConfigWaiter[] = [];
  for (const waiter of queue.waiters) {
    if (waiter.sequence > sequence) {
      remaining.push(waiter);
      continue;
    }

    if (waiter.sequence === sequence) {
      waiter.reject(error);
    } else {
      waiter.resolve({ applied: false });
    }
  }
  queue.waiters = remaining;
}

function settleAppliedWaiters(
  queue: SessionConfigQueue,
  request: QueuedSessionConfigRequest,
  configOptionsSnapshot?: AcpSessionConfigSnapshots,
  repaired = false,
) {
  const remaining: SessionConfigWaiter[] = [];
  for (const waiter of queue.waiters) {
    if (waiter.sequence > request.sequence) {
      remaining.push(waiter);
      continue;
    }

    const applied = sameSessionConfig(waiter.request, request);
    waiter.resolve({
      applied,
      ...(applied && configOptionsSnapshot ? { configOptionsSnapshot } : {}),
      ...(applied && repaired
        ? {
            repaired: true,
            resolvedProviderId: request.providerId,
            resolvedModelId: request.modelId ?? undefined,
          }
        : {}),
    });
  }
  queue.waiters = remaining;
}

function stillOwnsModelSelection(request: SessionConfigRequest): boolean {
  const currentIntent = useChatSessionStore
    .getState()
    .getModelSelectionIntent(request.sessionId);
  if (request.modelSelectionRequestId) {
    return currentIntent?.requestId === request.modelSelectionRequestId;
  }
  return currentIntent == null;
}

function mergeSessionConfigSnapshots(
  base: AcpSessionConfigSnapshots | undefined,
  next: AcpSessionConfigSnapshots | undefined,
): AcpSessionConfigSnapshots | undefined {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  return {
    model: next.model ?? base.model,
    reasoningEffort: next.reasoningEffort ?? base.reasoningEffort,
  };
}

async function resolveSessionConfigRequest(
  request: QueuedSessionConfigRequest,
): Promise<QueuedSessionConfigRequest & { repaired: boolean }> {
  const resolved = await repairManagedGooseModelSelection(
    request,
    request.repairSource ?? "session",
  );
  if (!resolved) return { ...request, repaired: false };
  const repaired =
    resolved.providerId !== request.providerId ||
    resolved.modelId !== request.modelId;
  if (repaired) {
    const queue = getQueue(request.sessionId);
    const repairedRequest = {
      ...request,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
    };
    if (queue.latest?.sequence === request.sequence) {
      queue.latest = repairedRequest;
    }
    const waiter = queue.waiters.find(
      (candidate) => candidate.sequence === request.sequence,
    );
    if (waiter) {
      waiter.request = repairedRequest;
    }
  }
  return {
    ...request,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    repaired,
  };
}

async function applyRequest(
  unresolvedRequest: QueuedSessionConfigRequest,
): Promise<{
  request: QueuedSessionConfigRequest & { repaired: boolean };
  snapshots?: AcpSessionConfigSnapshots;
}> {
  const request = await resolveSessionConfigRequest(unresolvedRequest);
  const prepareOptions = {
    ...(request.forceConfigRefresh && !request.modelId
      ? { forceConfigRefresh: true }
      : {}),
    ...(request.providerId === "goose" && request.modelId
      ? { modelId: request.modelId }
      : {}),
  };
  let snapshots =
    Object.keys(prepareOptions).length > 0
      ? await acpPrepareSession(
          request.sessionId,
          request.providerId,
          request.workingDir,
          prepareOptions,
        )
      : await acpPrepareSession(
          request.sessionId,
          request.providerId,
          request.workingDir,
        );
  if (request.modelId) {
    snapshots = mergeSessionConfigSnapshots(
      snapshots,
      request.forceConfigRefresh
        ? await acpSetModel(request.sessionId, request.modelId, {
            forceConfigRefresh: true,
          })
        : await acpSetModel(request.sessionId, request.modelId),
    );
  }
  return { request, snapshots };
}

async function drainQueue(sessionId: string, queue: SessionConfigQueue) {
  if (queue.running) {
    return;
  }

  queue.running = true;
  try {
    while (queue.latest) {
      const request = queue.latest;
      let appliedRequest: QueuedSessionConfigRequest & { repaired: boolean };
      let configOptionsSnapshot: AcpSessionConfigSnapshots | undefined;
      try {
        const applied = await applyRequest(request);
        appliedRequest = applied.request;
        configOptionsSnapshot = applied.snapshots;
      } catch (error) {
        if (queue.latest?.sequence !== request.sequence) {
          continue;
        }

        queue.latest = null;
        settleFailedWaiters(queue, request.sequence, error);
        break;
      }

      if (queue.latest?.sequence !== request.sequence) {
        continue;
      }

      queue.latest = null;
      if (appliedRequest.repaired && stillOwnsModelSelection(appliedRequest)) {
        useChatSessionStore.getState().patchSession(sessionId, {
          providerId: appliedRequest.providerId,
          modelId: appliedRequest.modelId ?? undefined,
          modelName: appliedRequest.modelId ?? undefined,
        });
      }
      settleAppliedWaiters(
        queue,
        appliedRequest,
        configOptionsSnapshot,
        appliedRequest.repaired && stillOwnsModelSelection(appliedRequest),
      );
      break;
    }
  } finally {
    queue.running = false;
    if (queue.latest) {
      void drainQueue(sessionId, queue);
    } else if (queue.waiters.length === 0) {
      queues.delete(sessionId);
    }
  }
}

export function applyLatestSessionConfig(
  request: SessionConfigRequest,
): Promise<SessionConfigResult> {
  const queue = getQueue(request.sessionId);
  const sequence = queue.nextSequence + 1;
  queue.nextSequence = sequence;
  const queuedRequest = { ...request, sequence };
  queue.latest = queuedRequest;

  const result = new Promise<SessionConfigResult>((resolve, reject) => {
    queue.waiters.push({
      sequence,
      request: queuedRequest,
      resolve,
      reject,
    });
  });

  void drainQueue(request.sessionId, queue);
  return result;
}
