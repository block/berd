import type {
  WorkspaceAttachment,
  WorkspaceAttachmentKind,
  WorkspaceAttachmentSource,
} from "@/shared/types/chat";
import {
  normalizeWorkspaceAttachmentLifecycle,
  normalizeWorkspacePath,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";

export const CHAT_WORKSPACE_METADATA_STORAGE_KEY =
  "goose:chat-workspace-metadata";
export const CHAT_WORKSPACE_METADATA_CHANGED_EVENT =
  "goose:chat-workspace-metadata-changed";

export interface PersistedChatWorkspaceMetadata {
  workspaceAttachments: WorkspaceAttachment[];
  activeWorkspaceId?: string | null;
  workingDir?: string | null;
}

type PersistedChatWorkspaceMetadataBySession = Record<
  string,
  PersistedChatWorkspaceMetadata
>;

function validWorkspaceKind(value: unknown): WorkspaceAttachmentKind {
  return value === "repository" ||
    value === "git-main-worktree" ||
    value === "git-linked-worktree" ||
    value === "git-detached-checkout" ||
    value === "subdirectory" ||
    value === "non-git-directory"
    ? value
    : "directory";
}

function validWorkspaceSource(value: unknown): WorkspaceAttachmentSource {
  return value === "selected" ||
    value === "created" ||
    value === "excluded" ||
    value === "inferred"
    ? value
    : "inferred";
}

function normalizePersistedWorkspaceAttachment(
  value: unknown,
): WorkspaceAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<WorkspaceAttachment>;
  const path = normalizeWorkspacePath(raw.path);
  if (!path) {
    return null;
  }

  const attachment: WorkspaceAttachment = {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id
        : workspaceAttachmentIdForPath(path),
    path,
    kind: validWorkspaceKind(raw.kind),
    source: validWorkspaceSource(raw.source),
    branch: typeof raw.branch === "string" ? raw.branch : null,
    usedByAgent: raw.usedByAgent === true,
  };
  const lifecycle = normalizeWorkspaceAttachmentLifecycle(raw.lifecycle);

  if (typeof raw.repositoryPath === "string" && raw.repositoryPath.trim()) {
    attachment.repositoryPath = raw.repositoryPath.trim();
  }
  if (typeof raw.worktreePath === "string" && raw.worktreePath.trim()) {
    attachment.worktreePath = raw.worktreePath.trim();
  }
  if (lifecycle) {
    attachment.lifecycle = lifecycle;
  }

  return attachment;
}

function normalizePersistedChatWorkspaceMetadata(
  value: unknown,
): PersistedChatWorkspaceMetadata | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<PersistedChatWorkspaceMetadata>;
  const workspaceAttachments = Array.isArray(raw.workspaceAttachments)
    ? raw.workspaceAttachments
        .map(normalizePersistedWorkspaceAttachment)
        .filter(
          (attachment): attachment is WorkspaceAttachment =>
            attachment !== null,
        )
    : [];

  if (workspaceAttachments.length === 0) {
    return null;
  }

  const attachmentIds = new Set(
    workspaceAttachments.map((attachment) => attachment.id),
  );
  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === "string" &&
    attachmentIds.has(raw.activeWorkspaceId)
      ? raw.activeWorkspaceId
      : null;

  const workingDir =
    typeof raw.workingDir === "string" && raw.workingDir.trim()
      ? raw.workingDir.trim()
      : null;

  return {
    workspaceAttachments,
    activeWorkspaceId,
    workingDir,
  };
}

function readAllPersistedChatWorkspaceMetadata(): PersistedChatWorkspaceMetadataBySession {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(
      CHAT_WORKSPACE_METADATA_STORAGE_KEY,
    );
    if (!stored) return {};

    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const bySession: PersistedChatWorkspaceMetadataBySession = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const normalized = normalizePersistedChatWorkspaceMetadata(value);
      if (normalized) {
        bySession[sessionId] = normalized;
      }
    }
    return bySession;
  } catch {
    return {};
  }
}

export interface ChatWorkspaceMetadataChangedDetail {
  sessionIds: string[];
}

function dispatchWorkspaceMetadataChanged(sessionIds: string[]): void {
  window.dispatchEvent(
    new CustomEvent<ChatWorkspaceMetadataChangedDetail>(
      CHAT_WORKSPACE_METADATA_CHANGED_EVENT,
      { detail: { sessionIds } },
    ),
  );
}

function writeAllPersistedChatWorkspaceMetadata(
  bySession: PersistedChatWorkspaceMetadataBySession,
  changedSessionIds: string[],
): void {
  if (typeof window === "undefined") return;

  try {
    if (Object.keys(bySession).length === 0) {
      window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
      dispatchWorkspaceMetadataChanged(changedSessionIds);
      return;
    }

    window.localStorage.setItem(
      CHAT_WORKSPACE_METADATA_STORAGE_KEY,
      JSON.stringify(bySession),
    );
    dispatchWorkspaceMetadataChanged(changedSessionIds);
  } catch {
    // localStorage may be unavailable
  }
}

export function loadPersistedChatWorkspaceMetadata(
  sessionId: string,
): PersistedChatWorkspaceMetadata | null {
  return readAllPersistedChatWorkspaceMetadata()[sessionId] ?? null;
}

export function persistChatWorkspaceMetadata(
  sessionId: string,
  metadata: PersistedChatWorkspaceMetadata,
): void {
  const normalized = normalizePersistedChatWorkspaceMetadata(metadata);
  const bySession = readAllPersistedChatWorkspaceMetadata();
  if (!normalized) {
    delete bySession[sessionId];
    writeAllPersistedChatWorkspaceMetadata(bySession, [sessionId]);
    return;
  }

  bySession[sessionId] = normalized;
  writeAllPersistedChatWorkspaceMetadata(bySession, [sessionId]);
}

export function removePersistedChatWorkspaceMetadata(sessionId: string): void {
  const bySession = readAllPersistedChatWorkspaceMetadata();
  if (!(sessionId in bySession)) return;

  delete bySession[sessionId];
  writeAllPersistedChatWorkspaceMetadata(bySession, [sessionId]);
}

export function subscribeToChatWorkspaceMetadata(
  listener: (sessionIds: string[] | null) => void,
): () => void {
  const handleChanged = (event: Event) => {
    listener(
      (event as CustomEvent<ChatWorkspaceMetadataChangedDetail>).detail
        ?.sessionIds ?? null,
    );
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== CHAT_WORKSPACE_METADATA_STORAGE_KEY) return;
    try {
      const before = JSON.parse(event.oldValue ?? "{}") as Record<
        string,
        unknown
      >;
      const after = JSON.parse(event.newValue ?? "{}") as Record<
        string,
        unknown
      >;
      const sessionIds = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].filter(
        (sessionId) =>
          JSON.stringify(before[sessionId]) !==
          JSON.stringify(after[sessionId]),
      );
      listener(sessionIds);
    } catch {
      listener(null);
    }
  };
  window.addEventListener(CHAT_WORKSPACE_METADATA_CHANGED_EVENT, handleChanged);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(
      CHAT_WORKSPACE_METADATA_CHANGED_EVENT,
      handleChanged,
    );
    window.removeEventListener("storage", handleStorage);
  };
}

export function migratePersistedChatWorkspaceMetadata(
  fromSessionId: string,
  toSessionId: string,
): void {
  const bySession = readAllPersistedChatWorkspaceMetadata();
  const metadata = bySession[fromSessionId];
  if (!metadata) return;

  bySession[toSessionId] = metadata;
  delete bySession[fromSessionId];
  writeAllPersistedChatWorkspaceMetadata(bySession, [
    fromSessionId,
    toSessionId,
  ]);
}
