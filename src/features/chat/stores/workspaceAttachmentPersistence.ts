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

export interface PersistedChatWorkspaceMetadata {
  workspaceAttachments: WorkspaceAttachment[];
  activeWorkspaceId?: string | null;
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

  return {
    workspaceAttachments,
    activeWorkspaceId,
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

function writeAllPersistedChatWorkspaceMetadata(
  bySession: PersistedChatWorkspaceMetadataBySession,
): void {
  if (typeof window === "undefined") return;

  try {
    if (Object.keys(bySession).length === 0) {
      window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      CHAT_WORKSPACE_METADATA_STORAGE_KEY,
      JSON.stringify(bySession),
    );
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
    writeAllPersistedChatWorkspaceMetadata(bySession);
    return;
  }

  bySession[sessionId] = normalized;
  writeAllPersistedChatWorkspaceMetadata(bySession);
}

export function removePersistedChatWorkspaceMetadata(sessionId: string): void {
  const bySession = readAllPersistedChatWorkspaceMetadata();
  if (!(sessionId in bySession)) return;

  delete bySession[sessionId];
  writeAllPersistedChatWorkspaceMetadata(bySession);
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
  writeAllPersistedChatWorkspaceMetadata(bySession);
}
