import { openPath } from "@tauri-apps/plugin-opener";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  Message,
  ToolCallLocation,
  ToolKind,
} from "@/shared/types/messages";
import { pathExists } from "@/shared/api/system";
import { isRemoteSession } from "@/features/chat/lib/remoteSession";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import {
  artifactBasename,
  isViewableArtifact,
} from "@/features/chat/lib/artifactViewerTypes";
import { isWithinBase } from "@/features/chat/lib/artifactAutoOpenPolicy";
import {
  fileUrlToPath,
  toComparablePath,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";

export interface ArtifactLinkCandidate {
  resolvedPath: string;
  rawPath: string;
  /**
   * True when `resolvedPath` is contained within the session working
   * directory (i.e. not an absolute path or `..`-escape that lands outside
   * the cwd). Consumers that want cwd-scoped behavior (e.g. inline local
   * Markdown images) must check this; it is `false` when there is no session
   * cwd to scope against.
   */
  isWithinSessionCwd: boolean;
  line?: number | null;
}

export interface SessionArtifact {
  resolvedPath: string;
  displayPath: string;
  filename: string;
  directoryPath: string;
  resolvedDirectoryPath: string;
  versionCount: number;
  lastTouchedAt: number;
  kind: "file" | "folder" | "path";
  toolName: string | null;
  toolKind?: ToolKind;
  line?: number | null;
}

export interface ArtifactPolicyContextValue {
  resolveMarkdownHref: (href: string) => ArtifactLinkCandidate | null;
  pathExists: (path: string) => Promise<boolean>;
  openResolvedPath: (path: string) => Promise<void>;
  /**
   * Primary "open this file" action for UI surfaces: viewable files
   * (markdown, images) open in the in-app viewer; everything else opens
   * externally. Resolves the path against the session cwd first.
   */
  openInApp: (path: string, filename?: string) => Promise<void>;
  /**
   * True when this session's backend runs on a remote SSH host, so the
   * transcript's file paths refer to that host's filesystem. Local existence
   * checks and `convertFileSrc` asset loads would 404; renderers show a
   * compact "on <host>" placeholder instead of attempting local file loads.
   */
  filesAreRemote: boolean;
  /** SSH host carrying this session's files when `filesAreRemote`. */
  remoteHost: string | null;
}

const DEFAULT_ACTIONS_CONTEXT_VALUE: ArtifactPolicyContextValue = {
  resolveMarkdownHref: () => null,
  pathExists: async () => false,
  openResolvedPath: async () => {},
  openInApp: async () => {},
  filesAreRemote: false,
  remoteHost: null,
};

const EMPTY_SESSION_ARTIFACTS: readonly SessionArtifact[] = [];

const ArtifactActionsContext = createContext<ArtifactPolicyContextValue>(
  DEFAULT_ACTIONS_CONTEXT_VALUE,
);

const ArtifactListContext = createContext<readonly SessionArtifact[]>(
  EMPTY_SESSION_ARTIFACTS,
);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

function normalizeComparablePath(path: string): string {
  return toIdentityKey(path.trim());
}

function parentDir(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash + 1);
}

function basenameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function hasExtension(path: string): boolean {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

function inferPathKind(path: string): SessionArtifact["kind"] {
  const normalized = normalizePath(path);
  if (normalized.endsWith("/")) return "folder";
  if (hasExtension(normalized)) return "file";
  return "path";
}

function hasBlockedMarkdownScheme(href: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) {
    return false;
  }

  return !href.toLowerCase().startsWith("file:");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function resolveRelativeToBase(base: string, relativePath: string): string {
  const normalizedBase = toComparablePath(base);
  const normalizedRelative = normalizePath(relativePath).replace(/^\.\/+/, "");
  if (!normalizedRelative || normalizedRelative === ".") return normalizedBase;

  const stack = normalizedBase.split("/").filter(Boolean);
  const hasWindowsDriveRoot = /^[a-zA-Z]:$/.test(stack[0] ?? "");
  const hasUncRoot = normalizedBase.startsWith("//") && stack.length >= 2;
  const minimumSegments = hasUncRoot ? 2 : hasWindowsDriveRoot ? 1 : 0;
  for (const segment of normalizedRelative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > minimumSegments) stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const resolved = stack.join("/");
  if (hasWindowsDriveRoot) return resolved;
  return hasUncRoot ? `//${resolved}` : `/${resolved}`;
}

// Markdown image/link destinations percent-encode characters that are not
// allowed raw in a URL destination — most commonly spaces (`%20`). Filesystem
// checks (`path_exists`) and `convertFileSrc` both expect a real, decoded path
// (the latter re-encodes internally, so a pre-encoded path would double-encode).
// Decode once here so every consumer works with the true path. Guarded because
// `decodeURIComponent` throws on malformed `%` sequences.
function decodePathIfEncoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolvePath(path: string, sessionCwd: string | null): string {
  const trimmed = path.trim();
  const fromFileUrl = fileUrlToPath(trimmed);
  if (fromFileUrl !== null) {
    return fromFileUrl;
  }
  if (/^file:/i.test(trimmed)) {
    return "";
  }

  const normalized = decodePathIfEncoded(normalizePath(path));
  if (!normalized) return "";

  if (isAbsolutePath(normalized)) {
    return normalized;
  }

  return sessionCwd
    ? resolveRelativeToBase(sessionCwd, normalized)
    : normalized;
}

function isNonEmptyLocation(
  location: ToolCallLocation,
): location is ToolCallLocation & { path: string } {
  return typeof location.path === "string" && location.path.trim().length > 0;
}

export function collectSessionArtifacts(
  messages: readonly Message[],
  cwd: string | null,
): SessionArtifact[] {
  const artifactMap = new Map<string, SessionArtifact>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.metadata?.userVisible === false) continue;

    for (const block of message.content) {
      if (block.type !== "toolRequest") continue;
      const locations = block.locations?.filter(isNonEmptyLocation) ?? [];

      for (const location of locations) {
        const resolvedPath = resolvePath(location.path, cwd);
        const key = normalizeComparablePath(resolvedPath);
        if (!key) continue;

        const existing = artifactMap.get(key);
        if (existing) {
          existing.versionCount += 1;
          if (message.created > existing.lastTouchedAt) {
            existing.lastTouchedAt = message.created;
            existing.toolName = block.toolName ?? block.name;
            existing.toolKind = block.toolKind;
            existing.line = location.line;
          }
          continue;
        }

        artifactMap.set(key, {
          resolvedPath,
          displayPath: resolvedPath,
          filename: basenameOf(resolvedPath),
          directoryPath: parentDir(resolvedPath),
          resolvedDirectoryPath: parentDir(resolvedPath),
          versionCount: 1,
          lastTouchedAt: message.created,
          kind: inferPathKind(resolvedPath),
          toolName: block.toolName ?? block.name,
          toolKind: block.toolKind,
          line: location.line,
        });
      }
    }
  }

  return Array.from(artifactMap.values()).sort(
    (a, b) => b.lastTouchedAt - a.lastTouchedAt,
  );
}

function getArtifactSignature(
  messages: readonly Message[],
  cwd: string | null,
): string {
  const parts = ["cwd", cwd ?? ""];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    // Mirror collectSessionArtifacts: hidden messages never contribute an
    // artifact, so they must not contribute to the signature either —
    // otherwise a hidden tool call would invalidate the cache and publish a
    // new (identical) list, defeating the stability optimization.
    if (message.metadata?.userVisible === false) continue;

    const toolRequestParts = [];
    for (const block of message.content) {
      if (block.type !== "toolRequest") continue;
      const locations = block.locations?.filter(isNonEmptyLocation) ?? [];
      if (locations.length === 0) continue;
      toolRequestParts.push([
        block.toolName ?? block.name,
        block.toolKind ?? null,
        locations.map((location) => [
          normalizePath(location.path),
          location.line ?? null,
        ]),
      ]);
    }

    if (toolRequestParts.length === 0) continue;

    parts.push(JSON.stringify([message.created, toolRequestParts]));
  }

  return parts.join("\n");
}

export function ArtifactPolicyProvider({
  messages,
  sessionCwd,
  sessionId,
  children,
}: {
  messages: Message[];
  sessionCwd: string | null;
  sessionId?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const openInViewer = useArtifactViewerStore((s) => s.open);
  const remoteHost = useChatSessionStore((s) => {
    if (!sessionId) return null;
    const session = s.sessions.find((candidate) => candidate.id === sessionId);
    return isRemoteSession(session)
      ? (session?.remoteHost?.trim() ?? null)
      : null;
  });
  const filesAreRemote = remoteHost !== null;
  const normalizedSessionCwd = useMemo(
    () => sessionCwd?.trim() || null,
    [sessionCwd],
  );
  const artifactCacheRef = useRef<{
    artifacts: SessionArtifact[];
    signature: string;
  } | null>(null);
  const lastOpenAtByPathRef = useRef(new Map<string, number>());

  // Recompute the content signature only when the message list or cwd changes,
  // then recollect artifacts only when that signature changes — keeping the
  // artifact array's identity stable across streaming text chunks that don't
  // touch any tool-call locations. cwd is part of the signature, so a cwd
  // change invalidates the cache on its own.
  const artifactSignature = useMemo(
    () => getArtifactSignature(messages, normalizedSessionCwd),
    [messages, normalizedSessionCwd],
  );
  if (
    !artifactCacheRef.current ||
    artifactCacheRef.current.signature !== artifactSignature
  ) {
    artifactCacheRef.current = {
      artifacts: collectSessionArtifacts(messages, normalizedSessionCwd),
      signature: artifactSignature,
    };
  }
  const artifacts = artifactCacheRef.current.artifacts;

  const resolveMarkdownHref = useCallback(
    (href: string): ArtifactLinkCandidate | null => {
      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith("#")) return null;
      if (hasBlockedMarkdownScheme(trimmed)) return null;

      if (/^file:/i.test(trimmed)) {
        const resolvedPath = resolvePath(trimmed, normalizedSessionCwd);
        if (!resolvedPath) return null;
        return {
          rawPath: trimmed,
          resolvedPath,
          isWithinSessionCwd: isWithinBase(normalizedSessionCwd, resolvedPath),
        };
      }

      const withoutHash = trimmed.split("#")[0];
      const withoutQuery = withoutHash.split("?")[0];
      if (!withoutQuery) return null;

      const resolvedPath = resolvePath(withoutQuery, normalizedSessionCwd);
      if (!resolvedPath) return null;
      return {
        rawPath: withoutQuery,
        resolvedPath,
        isWithinSessionCwd: isWithinBase(normalizedSessionCwd, resolvedPath),
      };
    },
    [normalizedSessionCwd],
  );

  const resolveOpenTarget = useCallback(
    async (path: string): Promise<string | null> => {
      // Remote sessions: the path names a file on the SSH host, so a local
      // existence probe is meaningless (and would report a false miss).
      if (filesAreRemote) return null;
      const resolvedPath = resolvePath(path, normalizedSessionCwd);
      if (await pathExists(resolvedPath)) {
        return resolvedPath;
      }

      return null;
    },
    [filesAreRemote, normalizedSessionCwd],
  );

  const checkPathExists = useCallback(
    async (path: string) => (await resolveOpenTarget(path)) !== null,
    [resolveOpenTarget],
  );

  const openResolvedPath = useCallback(
    async (path: string) => {
      if (filesAreRemote) {
        // Opening externally hands the path to the local OS, which cannot
        // reach the remote filesystem. Callers surface or swallow the error.
        throw new Error(
          t("remoteSessionGuards.openUnavailable", { host: remoteHost }),
        );
      }
      const resolvedTarget = await resolveOpenTarget(path);
      if (!resolvedTarget) {
        const cwdMessage = normalizedSessionCwd ?? "<none>";
        throw new Error(`File not found: ${path} (session cwd: ${cwdMessage})`);
      }

      const key = resolvedTarget.trim().toLowerCase();
      const now = Date.now();
      const lastOpenAt = lastOpenAtByPathRef.current.get(key) ?? 0;
      if (now - lastOpenAt < 1200) {
        return;
      }
      lastOpenAtByPathRef.current.set(key, now);
      await openPath(resolvedTarget);
    },
    [filesAreRemote, remoteHost, resolveOpenTarget, normalizedSessionCwd, t],
  );

  const openInApp = useCallback(
    async (path: string, filename?: string) => {
      if (filesAreRemote) {
        // The viewer renders a compact "on <host>" placeholder for remote
        // artifacts, so viewable files still open there (no existence check —
        // that would probe the local disk). Everything else has no local
        // hand-off; explain instead of silently launching the wrong file.
        const resolvedPath = resolvePath(path, normalizedSessionCwd);
        if (resolvedPath && sessionId && isViewableArtifact(resolvedPath)) {
          openInViewer(sessionId, {
            resolvedPath,
            filename: filename ?? artifactBasename(resolvedPath),
          });
          return;
        }
        toast.message(
          t("remoteSessionGuards.openUnavailable", { host: remoteHost }),
        );
        return;
      }
      const resolvedTarget = await resolveOpenTarget(path);
      // Viewable + resolvable + we know the session: open in the viewer.
      if (resolvedTarget && sessionId && isViewableArtifact(resolvedTarget)) {
        openInViewer(sessionId, {
          resolvedPath: resolvedTarget,
          filename: filename ?? artifactBasename(resolvedTarget),
        });
        return;
      }
      // Otherwise fall back to opening externally (also handles not-found).
      await openResolvedPath(path);
    },
    [
      filesAreRemote,
      normalizedSessionCwd,
      remoteHost,
      resolveOpenTarget,
      sessionId,
      openInViewer,
      openResolvedPath,
      t,
    ],
  );

  const actionsValue = useMemo<ArtifactPolicyContextValue>(
    () => ({
      resolveMarkdownHref,
      pathExists: checkPathExists,
      openResolvedPath,
      openInApp,
      filesAreRemote,
      remoteHost,
    }),
    [
      checkPathExists,
      filesAreRemote,
      openResolvedPath,
      openInApp,
      remoteHost,
      resolveMarkdownHref,
    ],
  );

  return (
    <ArtifactActionsContext.Provider value={actionsValue}>
      <ArtifactListContext.Provider value={artifacts}>
        {children}
      </ArtifactListContext.Provider>
    </ArtifactActionsContext.Provider>
  );
}

export function useArtifactActionsContext(): ArtifactPolicyContextValue {
  return useContext(ArtifactActionsContext);
}

export function useSessionArtifacts(): readonly SessionArtifact[] {
  return useContext(ArtifactListContext);
}
