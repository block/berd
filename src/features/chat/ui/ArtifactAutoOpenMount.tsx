import { useArtifactAutoOpen } from "../hooks/useArtifactAutoOpen";

/**
 * Headless mount for the auto-open effect. Must render inside
 * ArtifactPolicyProvider so it can read the session's artifact list.
 * `isHistoryLoading` keeps the baseline open while a reloaded transcript
 * streams in, so past artifacts never auto-open.
 */
export function ArtifactAutoOpenMount({
  sessionId,
  isHistoryLoading = false,
}: {
  sessionId?: string | null;
  isHistoryLoading?: boolean;
}) {
  useArtifactAutoOpen(sessionId, isHistoryLoading);
  return null;
}
