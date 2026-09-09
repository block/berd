import { invoke } from "@tauri-apps/api/core";
import { useChatSessionStore } from "./chatSessionStore";
import type { QueuedMessagePayload, QueuedMessageRecord } from "./chatStore";
import {
  isAdmittedQueuedMessagePayload,
  personaIntentFromComposer,
  type PersonaIntent,
} from "../lib/admittedSend";
import type { DeferredWorkspaceSend } from "../lib/firstWorkspaceSend";

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
): QueuedMessageRecord | null {
  const { editing: _editing, restored: _restored, ...persisted } = record;
  const normalizedPayload = normalizeQueuedPayload(persisted.payload);
  const restoredPayload =
    normalizedPayload.showInComposer === false &&
    normalizedPayload.sendOptions?.userMessageMetadata?.userVisible !== false
      ? { ...normalizedPayload, showInComposer: true }
      : normalizedPayload;
  if (persisted.kind !== "deferred") {
    if (!isAdmittedQueuedMessagePayload(restoredPayload)) return null;
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
    persona?: unknown;
    personaId?: unknown;
    personaName?: unknown;
  };
  const {
    providerId: legacyProviderId,
    modelId: legacyModelId,
    executionTarget: rawTarget,
    persona: rawPersona,
    personaId: legacyPersonaId,
    personaName: legacyPersonaName,
    ...rest
  } = legacy;

  let persona: PersonaIntent;
  if (rawPersona !== undefined) {
    if (!rawPersona || typeof rawPersona !== "object") {
      throw new Error("Invalid persisted queue persona intent.");
    }
    const candidate = rawPersona as Record<string, unknown>;
    if (candidate.kind === "inherit" || candidate.kind === "none") {
      persona = { kind: candidate.kind };
    } else if (
      candidate.kind === "persona" &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      (candidate.name === undefined || typeof candidate.name === "string")
    ) {
      persona = {
        kind: "persona",
        id: candidate.id,
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      };
    } else {
      throw new Error("Invalid persisted queue persona intent.");
    }
  } else if (
    legacyPersonaId === undefined ||
    legacyPersonaId === null ||
    typeof legacyPersonaId === "string"
  ) {
    persona = personaIntentFromComposer(
      legacyPersonaId,
      typeof legacyPersonaName === "string" ? legacyPersonaName : undefined,
    );
  } else {
    throw new Error("Invalid legacy queue persona intent.");
  }

  return {
    ...rest,
    persona,
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
      const records = value.filter(isQueuedRecord).flatMap((record) => {
        try {
          const normalized = normalizeQueuedRecord(record);
          return normalized ? [normalized] : [];
        } catch {
          return [];
        }
      });
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

// A session still creating (or failed to create) only exists under a
// client-local draft id that no restart can resolve, so persisting its queue
// would strand unreachable records; quitting mid-creation drops the message.
function isSessionPersistable(sessionId: string): boolean {
  return !useChatSessionStore.getState().getSession(sessionId)?.creationState;
}

export function persistMessageQueues(
  queues: PersistedQueues,
  changedSessionIds: string[],
): void {
  if (typeof window === "undefined" || changedSessionIds.length === 0) return;
  const updates = Object.fromEntries(
    changedSessionIds.map((sessionId) => [
      sessionId,
      queues[sessionId]?.length && isSessionPersistable(sessionId)
        ? queues[sessionId]
        : null,
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
