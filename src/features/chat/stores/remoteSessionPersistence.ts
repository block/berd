import {
  compositeSessionId,
  splitCompositeSessionId,
  sshBackendId,
} from "@/shared/api/acpBackendId";
import {
  registerSessionBackend,
  unregisterSessionBackend,
} from "@/shared/api/acpSessionBackends";

export const REMOTE_SESSIONS_STORAGE_KEY = "goose:remote-sessions:v1";

/**
 * Locally persisted identity of a session whose backend runs on a remote SSH
 * host. The local `goose serve` session list never returns these sessions, so
 * this record is what lets the sidebar show them (and route their calls to
 * the right backend) across app restarts.
 */
export interface RemoteSessionRecord {
  /**
   * Composite renderer-side session id (`ssh:<host>#<wireId>`). Records
   * written before composite ids existed hold the bare wire id; rehydration
   * migrates them using `host`.
   */
  sessionId: string;
  host: string;
  title: string;
  workingDir: string;
  updatedAt: string;
  /** Project the session belongs to; local grouping metadata. */
  projectId?: string;
  archivedAt?: string;
}

type RemoteSessionRecordsBySessionId = Record<string, RemoteSessionRecord>;

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRemoteSessionRecord(
  sessionId: string,
  value: unknown,
): RemoteSessionRecord | null {
  if (!sessionId.trim() || !value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<RemoteSessionRecord>;
  const host = trimmedString(raw.host);
  if (!host) {
    return null;
  }

  const record: RemoteSessionRecord = {
    sessionId,
    host,
    title: typeof raw.title === "string" ? raw.title : "",
    workingDir: trimmedString(raw.workingDir) ?? "",
    updatedAt: trimmedString(raw.updatedAt) ?? new Date(0).toISOString(),
  };
  const projectId = trimmedString(raw.projectId);
  if (projectId) {
    record.projectId = projectId;
  }
  const archivedAt = trimmedString(raw.archivedAt);
  if (archivedAt) {
    record.archivedAt = archivedAt;
  }
  return record;
}

function readAllRemoteSessionRecords(): RemoteSessionRecordsBySessionId {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(REMOTE_SESSIONS_STORAGE_KEY);
    if (!stored) return {};

    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const bySessionId: RemoteSessionRecordsBySessionId = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const normalized = normalizeRemoteSessionRecord(sessionId, value);
      if (normalized) {
        bySessionId[sessionId] = normalized;
      }
    }
    return bySessionId;
  } catch {
    return {};
  }
}

function writeAllRemoteSessionRecords(
  bySessionId: RemoteSessionRecordsBySessionId,
): void {
  if (typeof window === "undefined") return;

  try {
    if (Object.keys(bySessionId).length === 0) {
      window.localStorage.removeItem(REMOTE_SESSIONS_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      REMOTE_SESSIONS_STORAGE_KEY,
      JSON.stringify(bySessionId),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function persistRemoteSessionRecord(record: RemoteSessionRecord): void {
  const normalized = normalizeRemoteSessionRecord(record.sessionId, record);
  if (!normalized) return;

  const bySessionId = readAllRemoteSessionRecords();
  bySessionId[normalized.sessionId] = normalized;
  writeAllRemoteSessionRecords(bySessionId);
}

export function removeRemoteSessionRecord(sessionId: string): void {
  const bySessionId = readAllRemoteSessionRecords();
  if (!(sessionId in bySessionId)) return;

  delete bySessionId[sessionId];
  writeAllRemoteSessionRecords(bySessionId);
}

export function readRemoteSessionRecords(): RemoteSessionRecord[] {
  return Object.values(readAllRemoteSessionRecords());
}

/**
 * Restores remote sessions after an app restart: re-registers each record's
 * session→backend routing and seeds a placeholder
 * `ChatSession` so the sidebar can render it before the remote backend is
 * contacted. Activation reconciles the placeholder (title, counts, replay)
 * through the normal session-load path.
 *
 * The chat session store is imported lazily to keep this module free of an
 * import cycle with `chatSessionStore`, which calls the persistence writers
 * above.
 */
export async function rehydrateRemoteSessions(): Promise<void> {
  const records = readRemoteSessionRecords();
  if (records.length === 0) return;

  const { useChatSessionStore } = await import(
    "@/features/chat/stores/chatSessionStore"
  );
  const store = useChatSessionStore.getState();
  for (const record of records) {
    const backendId = sshBackendId(record.host);
    const split = splitCompositeSessionId(record.sessionId);
    // Old-format records (pre-composite ids) hold the bare wire id; compose
    // it so it cannot collide with a same-id local session, and migrate the
    // stored record so the composite id is the stable key from here on.
    const sessionId = split
      ? record.sessionId
      : compositeSessionId(backendId, record.sessionId);
    const wireSessionId = split?.wireSessionId ?? record.sessionId;
    registerSessionBackend(sessionId, backendId, wireSessionId);
    if (sessionId !== record.sessionId) {
      removeRemoteSessionRecord(record.sessionId);
      persistRemoteSessionRecord({ ...record, sessionId });
    }
    if (store.getSession(sessionId)) {
      continue;
    }
    store.addSession({
      id: sessionId,
      title: record.title || record.host,
      remoteHost: record.host,
      projectId: record.projectId,
      workingDir: record.workingDir || undefined,
      clientSessionId: sessionId,
      createdAt: record.updatedAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt,
      // Placeholder: the remote message count is unknown until the session
      // loads, and 0 would hide the row from the sidebar entirely.
      messageCount: 1,
    });
  }
}

/**
 * Apply the remote-session experiment at runtime without deleting the user's
 * persisted remote-session identities. Disabling hides those sessions and
 * disconnects their SSH tunnels; re-enabling restores the placeholders and
 * backend routing immediately.
 */
export async function reconcileRemoteSessionsForExperiment(
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await rehydrateRemoteSessions();
    return;
  }

  const records = readRemoteSessionRecords();
  const { useChatSessionStore } = await import(
    "@/features/chat/stores/chatSessionStore"
  );
  const state = useChatSessionStore.getState();
  const remoteSessionIds = new Set(
    state.sessions
      .filter((session) => Boolean(session.remoteHost))
      .map((session) => session.id),
  );
  const remoteHosts = new Set(
    state.sessions
      .map((session) => session.remoteHost?.trim())
      .filter((host): host is string => Boolean(host)),
  );

  for (const record of records) {
    const backendId = sshBackendId(record.host);
    const split = splitCompositeSessionId(record.sessionId);
    remoteSessionIds.add(
      split
        ? record.sessionId
        : compositeSessionId(backendId, record.sessionId),
    );
    remoteHosts.add(record.host);
  }

  useChatSessionStore.setState((current) => {
    const activeWorkspaceBySession = { ...current.activeWorkspaceBySession };
    const archiveMutationBySessionId = {
      ...current.archiveMutationBySessionId,
    };
    for (const sessionId of remoteSessionIds) {
      delete activeWorkspaceBySession[sessionId];
      delete archiveMutationBySessionId[sessionId];
    }
    return {
      sessions: current.sessions.filter(
        (session) => !remoteSessionIds.has(session.id),
      ),
      activeSessionId:
        current.activeSessionId && remoteSessionIds.has(current.activeSessionId)
          ? null
          : current.activeSessionId,
      activeWorkspaceBySession,
      archiveMutationBySessionId,
    };
  });

  for (const sessionId of remoteSessionIds) {
    unregisterSessionBackend(sessionId);
  }

  const { invalidateBackendConnection } = await import(
    "@/shared/api/acpConnection"
  );
  const { disconnectRemoteHost } = await import("@/shared/api/remoteHosts");
  await Promise.allSettled(
    [...remoteHosts].flatMap((host) => [
      invalidateBackendConnection(sshBackendId(host)),
      disconnectRemoteHost(host),
    ]),
  );
}
