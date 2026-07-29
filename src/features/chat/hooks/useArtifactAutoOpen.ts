import { useEffect, useRef } from "react";
import {
  useSessionArtifacts,
  type SessionArtifact,
} from "@/features/chat/hooks/ArtifactPolicyContext";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useArtifactAutoOpenPreference } from "@/features/chat/lib/artifactAutoOpenPreference";
import {
  shouldAutoOpenArtifact,
  type AutoOpenRoots,
} from "@/features/chat/lib/artifactAutoOpenPolicy";

/**
 * Auto-opens the viewer when the agent produces a document worth surfacing
 * *in the live session*, so "write me a blog post" lands on the right without
 * a click.
 *
 * Liveness is determined by when an artifact version FIRST APPEARS to this
 * hook — not by the containing message's `created` timestamp. Tool-call
 * updates patch locations onto an assistant message that keeps its original
 * timestamp, so a file written mid-run can look arbitrarily "old" by message
 * time; appearance tracking still catches it.
 *
 * Guardrails:
 *  - Importance, not just renderability: `shouldAutoOpenArtifact` requires an
 *    authored (not read) markdown file inside a place the user works — the
 *    session cwd or, for projectless chats, the artifact root — that isn't
 *    agent machinery. Screenshots, `SKILL.md` writes, PR-body temp files and
 *    plain reads no longer steal the panel. Every other surface can still open
 *    any viewable file manually.
 *  - One auto-open per run: the first qualifying document in a run opens; the
 *    rest are absorbed silently, so a run that writes six files doesn't
 *    thrash the panel. A later run can auto-open again.
 *  - Baseline on load: every artifact version present while the transcript is
 *    still loading (isHistoryLoading) — or already present on the first
 *    settled pass — is absorbed without opening. Only versions that appear
 *    after that baseline auto-open, so reloading a past chat never pops the
 *    viewer, even though its history arrives asynchronously.
 *  - Respects manual close: if the user closed the viewer, the same path won't
 *    re-pop until a different qualifying file appears.
 *  - Gated by the auto-open preference (default on). New versions are still
 *    absorbed while disabled so enabling it later doesn't replay a backlog.
 *  - Waits for roots: work roots resolve asynchronously, so live artifacts
 *    are left unconsumed (not absorbed) while no root is known yet. They are
 *    re-evaluated on the pass where a root arrives, instead of being silently
 *    rejected by a policy that could not yet say yes.
 */
export function useArtifactAutoOpen(
  sessionId: string | null | undefined,
  isHistoryLoading = false,
  roots: AutoOpenRoots = {},
) {
  const { sessionCwd = null, artifactRoot = null } = roots;
  const artifacts = useSessionArtifacts();
  const { enabled } = useArtifactAutoOpenPreference();
  const open = useArtifactViewerStore((s) => s.open);
  // Run identity scopes the "at most one auto-open" cap. Reading it from the
  // store keeps the cap keyed to the actual agent run rather than to wall
  // time or artifact counts.
  const activeRunId = useChatStore((s) =>
    sessionId ? (s.sessionStateById[sessionId]?.activeRunId ?? null) : null,
  );

  // Per-session watch state: which artifact versions we have already seen
  // (and therefore must not treat as live), whether the baseline pass has
  // completed, and which run we last auto-opened for.
  const watchRef = useRef<{
    sessionId: string | null | undefined;
    baselined: boolean;
    seen: Set<string>;
    autoOpenedRunKey: string | null;
  }>({
    sessionId: undefined,
    baselined: false,
    seen: new Set(),
    autoOpenedRunKey: null,
  });

  useEffect(() => {
    const signatureOf = (artifact: SessionArtifact) =>
      `${artifact.resolvedPath}:${artifact.versionCount}:${artifact.lastTouchedAt}`;

    // (Re)initialize on session change. Never open on this pass.
    if (watchRef.current.sessionId !== sessionId) {
      watchRef.current = {
        sessionId,
        baselined: false,
        seen: new Set(),
        autoOpenedRunKey: null,
      };
    }
    const watch = watchRef.current;

    // A history load can begin after this hook's first settled pass (for
    // example, when the app renders a restored session before activation has
    // marked its replay as loading). Reopen the baseline whenever that
    // happens so replayed artifacts cannot be mistaken for live edits.
    if (isHistoryLoading) {
      watch.baselined = false;
      for (const artifact of artifacts) {
        watch.seen.add(signatureOf(artifact));
      }
      return;
    }

    // Baseline: absorb everything that exists on the first settled pass after
    // mount or history loading. From then on, appearances are live.
    if (!watch.baselined) {
      for (const artifact of artifacts) {
        watch.seen.add(signatureOf(artifact));
      }
      watch.baselined = true;
      return;
    }

    // Live pass: anything with an unseen signature just appeared, regardless
    // of its message timestamp (mid-run location patches keep old ones).
    const fresh = artifacts.filter(
      (artifact) => !watch.seen.has(signatureOf(artifact)),
    );
    if (fresh.length === 0) return;

    // Absorb silently while disabled (or without a session): enabling the
    // preference later must not replay a backlog.
    if (!enabled || !sessionId) {
      for (const artifact of fresh) {
        watch.seen.add(signatureOf(artifact));
      }
      return;
    }

    // Work roots resolve asynchronously — the artifact root arrives over IPC
    // after mount — so a projectless chat can produce its first document
    // before any root is known. Consuming the artifact now would reject it
    // under a policy that cannot yet say yes, and it would never be
    // reconsidered. Leave it unconsumed instead: this effect reruns when the
    // roots change, and the artifact is still fresh on that pass.
    if (!sessionCwd && !artifactRoot) return;

    for (const artifact of fresh) {
      watch.seen.add(signatureOf(artifact));
    }

    // The artifact list is sorted by message time, so a live-patched file may
    // not lead it — pick from the fresh set instead. Importance (not mere
    // renderability) decides: authored markdown in the working tree that
    // isn't agent machinery.
    const candidate = fresh.find((artifact) =>
      shouldAutoOpenArtifact(
        {
          resolvedPath: artifact.resolvedPath,
          toolKind: artifact.toolKind,
          toolName: artifact.toolName,
        },
        { sessionCwd, artifactRoot },
      ),
    );
    if (!candidate) return;

    // At most one auto-open per run, so a run that writes six documents opens
    // the first and absorbs the rest instead of thrashing the panel.
    //
    // Only applies when the run is identifiable. If `activeRunId` is null we
    // deliberately skip the cap rather than falling back to a session-wide
    // key: a session-wide key would auto-open once and then stay silent for
    // the rest of the session, which is a far worse failure than an extra
    // open. The importance gates above are what actually prevent the
    // aggressive-feeling opens; this cap is only smoothing on top.
    if (activeRunId !== null && watch.autoOpenedRunKey === activeRunId) return;

    const state = useArtifactViewerStore.getState();
    const currentlyOpen = state.openBySession[sessionId] ?? null;
    const lastClosed = state.lastClosedPathBySession[sessionId] ?? null;

    // Respect a manual close: don't re-pop the exact path the user dismissed.
    // A *different* qualifying file still opens.
    if (!currentlyOpen && lastClosed === candidate.resolvedPath) return;

    watch.autoOpenedRunKey = activeRunId;
    open(sessionId, {
      resolvedPath: candidate.resolvedPath,
      filename: candidate.filename,
    });
  }, [
    sessionId,
    isHistoryLoading,
    enabled,
    artifacts,
    open,
    sessionCwd,
    artifactRoot,
    activeRunId,
  ]);
}
