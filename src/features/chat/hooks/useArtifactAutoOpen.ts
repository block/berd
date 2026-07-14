import { useEffect, useRef } from "react";
import {
  useSessionArtifacts,
  type SessionArtifact,
} from "@/features/chat/hooks/ArtifactPolicyContext";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import { useArtifactAutoOpenPreference } from "@/features/chat/lib/artifactAutoOpenPreference";
import { isViewableArtifact } from "@/features/chat/lib/artifactViewerTypes";

/**
 * Auto-opens the viewer when the agent touches a viewable file *in the live
 * session*, so "create a blog post" (or "open notes.md") surfaces the file to
 * the right without a click.
 *
 * Liveness is determined by when an artifact version FIRST APPEARS to this
 * hook — not by the containing message's `created` timestamp. Tool-call
 * updates patch locations onto an assistant message that keeps its original
 * timestamp, so a file written mid-run can look arbitrarily "old" by message
 * time; appearance tracking still catches it.
 *
 * Guardrails:
 *  - Baseline on load: every artifact version present while the transcript is
 *    still loading (isHistoryLoading) — or already present on the first
 *    settled pass — is absorbed without opening. Only versions that appear
 *    after that baseline auto-open, so reloading a past chat never pops the
 *    viewer, even though its history arrives asynchronously.
 *  - Respects manual close: if the user closed the viewer, the same path won't
 *    re-pop until a different viewable file appears.
 *  - Gated by the auto-open preference (default on). New versions are still
 *    absorbed while disabled so enabling it later doesn't replay a backlog.
 */
export function useArtifactAutoOpen(
  sessionId: string | null | undefined,
  isHistoryLoading = false,
) {
  const artifacts = useSessionArtifacts();
  const { enabled } = useArtifactAutoOpenPreference();
  const open = useArtifactViewerStore((s) => s.open);

  // Per-session watch state: which artifact versions we have already seen
  // (and therefore must not treat as live), and whether the baseline pass
  // has completed.
  const watchRef = useRef<{
    sessionId: string | null | undefined;
    baselined: boolean;
    seen: Set<string>;
  }>({ sessionId: undefined, baselined: false, seen: new Set() });

  useEffect(() => {
    const signatureOf = (artifact: SessionArtifact) =>
      `${artifact.resolvedPath}:${artifact.versionCount}:${artifact.lastTouchedAt}`;

    // (Re)initialize on session change. Never open on this pass.
    if (watchRef.current.sessionId !== sessionId) {
      watchRef.current = { sessionId, baselined: false, seen: new Set() };
    }
    const watch = watchRef.current;

    // Baseline: absorb everything that exists while history is loading (a
    // reloaded transcript arrives asynchronously). The baseline closes on the
    // first pass where history is settled; from then on, appearances are live.
    if (!watch.baselined) {
      for (const artifact of artifacts) {
        watch.seen.add(signatureOf(artifact));
      }
      if (!isHistoryLoading) {
        watch.baselined = true;
      }
      return;
    }

    // Live pass: anything with an unseen signature just appeared, regardless
    // of its message timestamp (mid-run location patches keep old ones).
    const fresh = artifacts.filter(
      (artifact) => !watch.seen.has(signatureOf(artifact)),
    );
    if (fresh.length === 0) return;
    for (const artifact of fresh) {
      watch.seen.add(signatureOf(artifact));
    }

    if (!enabled || !sessionId) return;

    // The artifact list is sorted by message time, so a live-patched file may
    // not lead it — pick from the fresh set instead.
    const candidate = fresh.find((artifact) =>
      isViewableArtifact(artifact.resolvedPath),
    );
    if (!candidate) return;

    const state = useArtifactViewerStore.getState();
    const currentlyOpen = state.openBySession[sessionId] ?? null;
    const lastClosed = state.lastClosedPathBySession[sessionId] ?? null;

    // Respect a manual close: don't re-pop the exact path the user dismissed.
    // A *different* viewable file still opens.
    if (!currentlyOpen && lastClosed === candidate.resolvedPath) return;

    open(sessionId, {
      resolvedPath: candidate.resolvedPath,
      filename: candidate.filename,
    });
  }, [sessionId, isHistoryLoading, enabled, artifacts, open]);
}
