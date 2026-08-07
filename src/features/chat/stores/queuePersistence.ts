import { invoke } from "@tauri-apps/api/core";
import type { QueuedMessagePayload, QueuedMessageRecord } from "./chatStore";
import type { DeferredWorkspaceSend } from "../lib/firstWorkspaceSend";
import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "../lib/sessionExecutionTarget";
import { executionTargetFromGooseServeSession } from "../lib/gooseServeExecutionTarget";

const QUEUES_STORAGE_KEY = "goose:chat-message-queues:v1";
let nativeWriteChain = Promise.resolve();

type PersistedQueues = Record<string, QueuedMessageRecord[]>;

function isQueuedRecord(value: unknown): value is QueuedMessageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== "transport-ready" && record.kind !== "deferred") ||
    typeof record.recordId !== "string" ||
    !record.recordId
  ) {
    return false;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return false;
  if (typeof (payload as Record<string, unknown>).text !== "string") {
    return false;
  }
  if (record.kind === "deferred") {
    const state = record.state;
    if (!state || typeof state !== "object") return false;
    return (
      (state as Record<string, unknown>).type === "workspace-first-send" &&
      ["choice", "naming", "creating", "held", "failed"].includes(
        String((state as Record<string, unknown>).status),
      )
    );
  }
  return true;
}

function normalizeQueuedRecord(
  record: QueuedMessageRecord,
): QueuedMessageRecord {
  const { editing: _editing, restored: _restored, ...persisted } = record;
  const normalizedPayload = normalizeQueuedPayload(persisted.payload);
  const restoredPayload =
    normalizedPayload.showInComposer === false
      ? { ...normalizedPayload, showInComposer: true }
      : normalizedPayload;
  if (persisted.kind !== "deferred") {
    return { ...persisted, payload: restoredPayload, restored: true };
  }
  const state = persisted.state as Partial<DeferredWorkspaceSend> | undefined;
  if (state?.type !== "workspace-first-send") {
    return persisted;
  }
  if (state.status === "creating") {
    return {
      ...persisted,
      payload: restoredPayload,
      state: {
        ...state,
        status: "held",
        error: "Workspace setup was interrupted. Review the plan and retry.",
      },
      restored: true,
    };
  }
  return {
    ...persisted,
    payload: restoredPayload,
    restored: true,
  };
}

function normalizeQueuedPayload(
  payload: QueuedMessagePayload,
): QueuedMessagePayload {
  const legacy = payload as QueuedMessagePayload & {
    providerId?: unknown;
    modelId?: unknown;
    executionTarget?: unknown;
  };
  const {
    providerId: legacyProviderId,
    modelId: legacyModelId,
    executionTarget: rawTarget,
    ...rest
  } = legacy;

  let executionTarget: SessionExecutionTarget | undefined;
  if (rawTarget && typeof rawTarget === "object") {
    const candidate = rawTarget as unknown as Record<string, unknown>;
    if (typeof candidate.harnessId === "string") {
      try {
        executionTarget = normalizeSessionExecutionTarget({
          harnessId: candidate.harnessId,
          modelProviderId:
            typeof candidate.modelProviderId === "string"
              ? candidate.modelProviderId
              : undefined,
          modelId:
            typeof candidate.modelId === "string"
              ? candidate.modelId
              : undefined,
          modelName:
            typeof candidate.modelName === "string"
              ? candidate.modelName
              : undefined,
        });
      } catch {
        // Invalid persisted selections do not override the live session target.
      }
    }
  } else if (typeof legacyProviderId === "string") {
    executionTarget = executionTargetFromGooseServeSession({
      providerId: legacyProviderId,
      modelId: typeof legacyModelId === "string" ? legacyModelId : undefined,
    });
  }

  return {
    ...rest,
    ...(executionTarget ? { executionTarget } : {}),
  };
}

export async function loadPersistedMessageQueues(): Promise<PersistedQueues> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return loadCachedMessageQueues();
  }
  try {
    const stored = await invoke<string | null>("load_message_queues");
    if (!stored) return loadCachedMessageQueues();
    const queues = parseMessageQueues(stored);
    try {
      window.localStorage.setItem(QUEUES_STORAGE_KEY, stored);
    } catch {
      // Native persistence remains authoritative for oversized queues.
    }
    return queues;
  } catch {
    return loadCachedMessageQueues();
  }
}

function parseMessageQueues(stored: string): PersistedQueues {
  const parsed: unknown = JSON.parse(stored);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([sessionId, value]) => {
      if (!Array.isArray(value)) return [];
      const records = value.filter(isQueuedRecord).map(normalizeQueuedRecord);
      return records.length > 0 ? [[sessionId, records]] : [];
    }),
  );
}

export function loadCachedMessageQueues(): PersistedQueues {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(QUEUES_STORAGE_KEY);
    return stored ? parseMessageQueues(stored) : {};
  } catch {
    return {};
  }
}

export function persistMessageQueues(
  queues: PersistedQueues,
  changedSessionIds: string[],
): void {
  if (typeof window === "undefined" || changedSessionIds.length === 0) return;
  const updates = Object.fromEntries(
    changedSessionIds.map((sessionId) => [
      sessionId,
      queues[sessionId]?.length ? queues[sessionId] : null,
    ]),
  );
  if (window.__TAURI_INTERNALS__) {
    nativeWriteChain = nativeWriteChain
      .then(() =>
        invoke<void>("persist_message_queue_updates", {
          serializedUpdates: JSON.stringify(updates),
        }),
      )
      .catch((error) => {
        console.error("Failed to persist message queues:", error);
      });
  }
  refreshCachedMessageQueues(updates);
}

export function refreshCachedMessageQueues(
  updates: Record<string, QueuedMessageRecord[] | null>,
): void {
  if (typeof window === "undefined") return;
  try {
    const cached = loadCachedMessageQueues();
    for (const [sessionId, records] of Object.entries(updates)) {
      if (records?.length) cached[sessionId] = records;
      else delete cached[sessionId];
    }
    const serialized = Object.keys(cached).length
      ? JSON.stringify(cached)
      : null;
    if (serialized) window.localStorage.setItem(QUEUES_STORAGE_KEY, serialized);
    else window.localStorage.removeItem(QUEUES_STORAGE_KEY);
  } catch {
    // The native file remains authoritative when localStorage is unavailable
    // or the queue contains inline image data that exceeds its quota.
  }
}
