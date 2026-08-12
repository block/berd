import { useResolvedArtifactRoot } from "@/shared/artifacts/useResolvedArtifactRoot";
import { useArtifactAutoOpen } from "../hooks/useArtifactAutoOpen";

/**
 * Headless mount for the auto-open effect. Must render inside
 * ArtifactPolicyProvider so it can read the session's artifact list.
 *
 * `isHistoryLoading` keeps the baseline open while a reloaded transcript
 * streams in, so past artifacts never auto-open.
 *
 * Auto-open is scoped to places the user actually works. Project-backed
 * sessions supply `sessionCwd`; projectless "general" chats have no project
 * root and write to the artifact root instead, so this mount reads that
 * root itself rather than making every caller thread it through. It must be
 * the *resolved* root — artifact locations arrive as absolute paths, so a
 * stored `~/…` preference would never match them.
 */
export function ArtifactAutoOpenMount({
  sessionId,
  isHistoryLoading = false,
  sessionCwd = null,
}: {
  sessionId?: string | null;
  isHistoryLoading?: boolean;
  sessionCwd?: string | null;
}) {
  const artifactRoot = useResolvedArtifactRoot();
  useArtifactAutoOpen(sessionId, isHistoryLoading, {
    sessionCwd,
    artifactRoot,
  });
  return null;
}
