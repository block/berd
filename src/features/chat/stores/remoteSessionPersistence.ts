import { sshBackendId } from "@/shared/api/acpBackendId";
import { registerSessionBackend } from "@/shared/api/acpSessionBackends";

export const REMOTE_SESSIONS_STORAGE_KEY = "goose:remote-sessions:v1";

/**
 * Locally persisted identity of a session whose backend runs on a remote SSH
 * host. The local `goose serve` session list never returns these sessions, so
 * this record is what lets the sidebar show them (and route their calls to
 * the right backend) across app restarts.
 */
export interface RemoteSessionRecord {
  sessionId: string;
  host: string;
  title: string;
  workingDir: string;
  updatedAt: string;
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
 * Restores remote sessions after an app restart: re-registers each
 * non-archived record's session→backend routing and seeds a placeholder
 * `ChatSession` so the sidebar can render it before the remote backend is
 * contacted. Activation reconciles the placeholder (title, counts, replay)
 * through the normal session-load path.
 *
 * The chat session store is imported lazily to keep this module free of an
 * import cycle with `chatSessionStore`, which calls the persistence writers
 * above.
 */
export async function rehydrateRemoteSessions(): Promise<void> {
  const records = readRemoteSessionRecords().filter(
    (record) => !record.archivedAt,
  );
  if (records.length === 0) return;

  const { useChatSessionStore } = await import(
    "@/features/chat/stores/chatSessionStore"
  );
  const store = useChatSessionStore.getState();
  for (const record of records) {
    registerSessionBackend(record.sessionId, sshBackendId(record.host));
    if (store.getSession(record.sessionId)) {
      continue;
    }
    store.addSession({
      id: record.sessionId,
      title: record.title || record.host,
      remoteHost: record.host,
      workingDir: record.workingDir || undefined,
      clientSessionId: record.sessionId,
      createdAt: record.updatedAt,
      updatedAt: record.updatedAt,
      // Placeholder: the remote message count is unknown until the session
      // loads, and 0 would hide the row from the sidebar entirely.
      messageCount: 1,
    });
  }
}
