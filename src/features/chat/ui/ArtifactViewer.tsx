import { convertFileSrc } from "@tauri-apps/api/core";
import {
  EllipsisIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  ImageIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactHeader,
  ArtifactTitle,
} from "@/shared/ui/ai-elements/artifact";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { MarkdownImage } from "@/features/chat/ui/MarkdownImage";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Spinner } from "@/shared/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import {
  fileStatErrorKind,
  readTextFile,
  statFile,
  type FileStatErrorKind,
} from "@/shared/api/system";
import { cn } from "@/shared/lib/cn";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { getPlatform } from "@/shared/lib/platform";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import { classifyArtifactView } from "@/features/chat/lib/artifactViewerTypes";
import type { OpenArtifact } from "@/features/chat/stores/artifactViewerStore";

// Platform-aware reveal label ("Reveal in Finder" / "Explorer" / "File
// Manager"), matching FileContextMenu so the doc viewer and right-click
// menus name the same action identically.
const revealLabelKey =
  `common:labels.revealInFileManager_${getPlatform()}` as const;

interface ArtifactViewerProps {
  artifact: OpenArtifact;
  onClose: () => void;
  /**
   * SSH host carrying the session's files, when the session is remote. The
   * viewer then renders a compact placeholder (file name + host chip) instead
   * of statting/reading/polling the path on the local filesystem, and hides
   * the local-only hand-off actions (open in editor, reveal).
   */
  remoteHost?: string | null;
}

type MarkdownView = "preview" | "raw";
type DiskStatus = "current" | "checking" | "diverged";

interface TextState {
  status: "loading" | "loaded" | "error";
  contents: string;
}

interface FileFingerprint {
  byteSize: string;
  modifiedAtNs: string;
  changedAtNs?: string;
}

const FOREGROUND_ARTIFACT_POLL_INTERVAL_MS = 1_500;
const BACKGROUND_ARTIFACT_POLL_INTERVAL_MS = 10_000;
// Consecutive failed poll cycles tolerated before the stale warning shows. A
// single failure is routinely a file mid-rewrite or a transient I/O hiccup;
// two in a row is a real divergence worth surfacing.
const DIVERGENCE_STRIKE_THRESHOLD = 2;
// Upper bound on any single stat/read/decode step of a freshness cycle. These
// awaits cross IPC into filesystem calls that can hang indefinitely (stalled
// network mounts, yanked removable media — the Rust side uses spawn_blocking
// for exactly this reason), and an unbounded await here wedges the viewer: a
// stuck forced refresh suppresses all polling via forcedRefreshInFlightRef,
// and a stuck poll never reaches scheduleNextPoll. Ten seconds is comfortably
// beyond any healthy local operation while still funneling a genuine hang
// into the existing failure paths (error state, divergence strikes) before
// the viewer reads as dead.
const PRESENTATION_TIMEOUT_MS = 10_000;

class PresentationTimeoutError extends Error {
  constructor() {
    super("Artifact presentation timed out");
    this.name = "PresentationTimeoutError";
  }
}

// Bounds one stat/read/decode step. On timeout the wrapper rejects with
// PresentationTimeoutError so the caller's catch/finally blocks run — clearing
// the in-flight flags and letting polling continue. A later settlement of the
// underlying promise only re-settles the already-rejected wrapper, which is a
// no-op per the Promise spec: the awaiting effect code never resumes, so a
// timed-out operation cannot deliver stale bytes over newer state. (The
// generation guards remain in place as an independent second line of
// defense.) Attaching the rejection handler here also keeps a late failure of
// the underlying promise from surfacing as an unhandled rejection.
function withPresentationTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timerId = window.setTimeout(
      () => reject(new PresentationTimeoutError()),
      PRESENTATION_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timerId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timerId);
        reject(error);
      },
    );
  });
}

function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint,
): boolean {
  return (
    left.byteSize === right.byteSize &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}

export function ArtifactViewer({
  artifact,
  onClose,
  remoteHost = null,
}: ArtifactViewerProps) {
  const { t } = useTranslation(["chat", "common"]);
  const { openResolvedPath } = useArtifactActionsContext();
  const viewMode = useMemo(
    () => classifyArtifactView(artifact.resolvedPath),
    [artifact.resolvedPath],
  );
  const [markdownView, setMarkdownView] = useState<MarkdownView>("preview");
  const [textState, setTextState] = useState<TextState>({
    status: "loading",
    contents: "",
  });
  const textStateRef = useRef(textState);
  const displayedPathRef = useRef(artifact.resolvedPath);
  const fingerprintRef = useRef<FileFingerprint | null>(null);
  const [diskStatus, setDiskStatus] = useState<DiskStatus>("checking");
  const diskStatusRef = useRef<DiskStatus>(diskStatus);
  const [divergedKind, setDivergedKind] = useState<FileStatErrorKind>("other");
  const divergenceStrikesRef = useRef(0);
  const [imageDiskRevision, setImageDiskRevision] = useState(0);
  const imageDiskRevisionRef = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const consumedRetryRevisionRef = useRef(0);
  const renderedTextState: TextState =
    displayedPathRef.current === artifact.resolvedPath
      ? textState
      : { status: "loading", contents: "" };
  const contentReadRevision = artifact.revision;
  const forcedRefreshGenerationRef = useRef(0);
  const forcedRefreshInFlightRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const loadedImageSrcRef = useRef<string | null>(null);
  const pendingImageRef = useRef<{
    src: string;
    fingerprint: FileFingerprint;
  } | null>(null);
  const imageSrc = useMemo(
    () =>
      artifactImageSrc(
        artifact.resolvedPath,
        artifact.revision + imageDiskRevision,
      ),
    [artifact.resolvedPath, artifact.revision, imageDiskRevision],
  );

  const updateTextState = useCallback((next: TextState) => {
    textStateRef.current = next;
    setTextState(next);
  }, []);
  const updateDiskStatus = useCallback((next: DiskStatus) => {
    diskStatusRef.current = next;
    setDiskStatus(next);
    // Any non-diverged outcome ends the current failure streak, so recovery
    // both clears the warning and re-arms the full grace period.
    if (next !== "diverged") divergenceStrikesRef.current = 0;
  }, []);
  const flagDiverged = useCallback(
    (kind: FileStatErrorKind) => {
      setDivergedKind(kind);
      updateDiskStatus("diverged");
    },
    [updateDiskStatus],
  );
  // Polling failures get a grace period: one failed cycle is routinely a file
  // mid-rewrite or a transient I/O error, so only consecutive failures flag
  // the view as diverged. User-initiated reloads bypass this via flagDiverged.
  const recordDivergenceStrike = useCallback(
    (kind: FileStatErrorKind) => {
      divergenceStrikesRef.current += 1;
      if (divergenceStrikesRef.current >= DIVERGENCE_STRIKE_THRESHOLD) {
        flagDiverged(kind);
      }
    },
    [flagDiverged],
  );

  // Escape closes the viewer — but only when nothing closer to the event
  // already handled it (open menus, dialogs, transcript search, etc.).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Establish both the rendered content and the disk fingerprint. Re-reads of
  // the same path retain last-good content while loading so tool-triggered and
  // manual refreshes do not flash a spinner or reset the scroll container.
  useEffect(() => {
    // Remote artifacts: no local stat/read — the placeholder body is the view.
    if (remoteHost) return;
    let cancelled = false;
    const refreshGeneration = ++forcedRefreshGenerationRef.current;
    // A forced ACP/manual refresh supersedes a poll already in flight. Polls
    // never supersede forced work; they pause until it completes.
    pollGenerationRef.current += 1;
    forcedRefreshInFlightRef.current = true;
    const isCurrentRefresh = () =>
      !cancelled && refreshGeneration === forcedRefreshGenerationRef.current;
    const finishRefresh = () => {
      if (refreshGeneration === forcedRefreshGenerationRef.current) {
        forcedRefreshInFlightRef.current = false;
      }
    };
    const pathChanged = displayedPathRef.current !== artifact.resolvedPath;
    if (pathChanged) {
      displayedPathRef.current = artifact.resolvedPath;
      fingerprintRef.current = null;
      pendingImageRef.current = null;
      loadedImageSrcRef.current = null;
      consumedRetryRevisionRef.current = retryRevision;
      updateTextState({ status: "loading", contents: "" });
      imageDiskRevisionRef.current = 0;
      setImageDiskRevision(0);
    } else if (
      viewMode !== "image" &&
      textStateRef.current.status !== "loaded"
    ) {
      updateTextState({ status: "loading", contents: "" });
    }
    if (pathChanged || diskStatusRef.current !== "diverged") {
      updateDiskStatus("checking");
    }
    // An unconsumed retry revision means the user pressed Reload. That intent
    // matters on failure: the user asked "is the file back?", so the answer is
    // immediate rather than smoothed over by the polling grace period.
    const userReloadRequested =
      retryRevision !== consumedRetryRevisionRef.current;

    // Reading this value makes the ACP-driven revision an explicit input to
    // this request even though only its change, not its numeric value, matters.
    void contentReadRevision;
    void (async () => {
      try {
        const before = await withPresentationTimeout(
          statFile(artifact.resolvedPath),
        );
        if (!isCurrentRefresh()) return;

        if (viewMode === "image") {
          const shouldBustImageCache = userReloadRequested;
          const candidateDiskRevision = shouldBustImageCache
            ? imageDiskRevisionRef.current + 1
            : imageDiskRevisionRef.current;
          const candidateSrc = artifactImageSrc(
            artifact.resolvedPath,
            artifact.revision + candidateDiskRevision,
          );
          let confirmedFingerprint = before;
          if (shouldBustImageCache) {
            await withPresentationTimeout(preloadArtifactImage(candidateSrc));
            if (!isCurrentRefresh()) return;
            confirmedFingerprint = await withPresentationTimeout(
              statFile(artifact.resolvedPath),
            );
            if (!isCurrentRefresh()) return;
            if (!sameFingerprint(before, confirmedFingerprint)) {
              // Torn write: the file changed while the image was decoding.
              // Leave the current state alone and let the next cycle retry
              // against the settled file.
              return;
            }
            imageDiskRevisionRef.current = candidateDiskRevision;
            consumedRetryRevisionRef.current = retryRevision;
            setImageDiskRevision(candidateDiskRevision);
          }
          pendingImageRef.current = {
            src: candidateSrc,
            fingerprint: confirmedFingerprint,
          };
          if (loadedImageSrcRef.current === candidateSrc) {
            fingerprintRef.current = before;
            pendingImageRef.current = null;
            updateDiskStatus("current");
          }
          return;
        }

        const payload = await withPresentationTimeout(
          readTextFile(artifact.resolvedPath),
        );
        const after = await withPresentationTimeout(
          statFile(artifact.resolvedPath),
        );
        if (!isCurrentRefresh()) return;
        if (!sameFingerprint(before, after)) {
          // Torn write: the file changed underneath the read, so neither the
          // fetched contents nor a divergence verdict is trustworthy. Keep the
          // current state and let the next poll cycle retry the settled file.
          return;
        }

        fingerprintRef.current = after;
        if (
          textStateRef.current.contents !== payload.contents ||
          textStateRef.current.status !== "loaded"
        ) {
          updateTextState({ status: "loaded", contents: payload.contents });
        }
        consumedRetryRevisionRef.current = retryRevision;
        updateDiskStatus("current");
      } catch (error) {
        if (!isCurrentRefresh()) return;
        const kind = fileStatErrorKind(error);
        const hasLastGoodView = textStateRef.current.status === "loaded";
        if (!hasLastGoodView) {
          updateTextState({ status: "error", contents: "" });
        }
        if (userReloadRequested) {
          // The user explicitly asked whether the file is back, so answer
          // immediately instead of smoothing the failure over with the
          // polling grace period.
          consumedRetryRevisionRef.current = retryRevision;
          flagDiverged(kind);
        } else if (hasLastGoodView) {
          // ACP-driven re-open of already-rendered content: tool writes
          // routinely race the re-read, so give the failure the same grace
          // as a polling failure.
          recordDivergenceStrike(kind);
        } else {
          // Initial load (or path change) failure: there is no last-good view
          // to protect, so the error state and warning show immediately.
          flagDiverged(kind);
        }
      } finally {
        finishRefresh();
      }
    })();

    return () => {
      cancelled = true;
      if (refreshGeneration === forcedRefreshGenerationRef.current) {
        forcedRefreshGenerationRef.current += 1;
        forcedRefreshInFlightRef.current = false;
      }
    };
  }, [
    artifact.resolvedPath,
    artifact.revision,
    contentReadRevision,
    flagDiverged,
    recordDivergenceStrike,
    remoteHost,
    retryRevision,
    updateDiskStatus,
    updateTextState,
    viewMode,
  ]);

  // Tool events cannot account for shell writes, delegated subagents, or
  // external editors. Poll the one open file while this document is visible,
  // slowing down when the app is not focused and checking immediately when it
  // returns to the foreground.
  useEffect(() => {
    // No freshness polling for remote artifacts — the file is not local.
    if (remoteHost) return;
    let cancelled = false;
    let checkInFlight = false;
    let pollTimerId: number | null = null;

    const checkForDiskChange = async () => {
      if (
        document.visibilityState === "hidden" ||
        checkInFlight ||
        forcedRefreshInFlightRef.current
      ) {
        return;
      }
      const pollGeneration = ++pollGenerationRef.current;
      const isCurrentPoll = () =>
        !cancelled &&
        pollGeneration === pollGenerationRef.current &&
        !forcedRefreshInFlightRef.current;
      checkInFlight = true;
      try {
        const fingerprint = await withPresentationTimeout(
          statFile(artifact.resolvedPath),
        );
        if (!isCurrentPoll()) return;
        const previous = fingerprintRef.current;
        if (
          previous &&
          sameFingerprint(previous, fingerprint) &&
          diskStatusRef.current !== "diverged"
        ) {
          updateDiskStatus("current");
          return;
        }
        // A diverged view always retries the content/decode even when stat has
        // returned to the last fingerprint, so transient failures self-heal.

        if (viewMode === "image") {
          const candidateDiskRevision = imageDiskRevisionRef.current + 1;
          const candidateSrc = artifactImageSrc(
            artifact.resolvedPath,
            artifact.revision + candidateDiskRevision,
          );
          await withPresentationTimeout(preloadArtifactImage(candidateSrc));
          if (!isCurrentPoll()) return;
          const confirmedFingerprint = await withPresentationTimeout(
            statFile(artifact.resolvedPath),
          );
          if (!isCurrentPoll()) return;
          if (!sameFingerprint(fingerprint, confirmedFingerprint)) {
            // Torn write: the file changed while the image was decoding, so
            // the decoded bytes are already stale. Neither flag nor strike —
            // the next cycle retries against the settled file.
            return;
          }
          pendingImageRef.current = {
            src: candidateSrc,
            fingerprint: confirmedFingerprint,
          };
          imageDiskRevisionRef.current = candidateDiskRevision;
          setImageDiskRevision(candidateDiskRevision);
          return;
        }

        const payload = await withPresentationTimeout(
          readTextFile(artifact.resolvedPath),
        );
        if (!isCurrentPoll()) return;
        const confirmedFingerprint = await withPresentationTimeout(
          statFile(artifact.resolvedPath),
        );
        if (!isCurrentPoll()) return;
        if (!sameFingerprint(fingerprint, confirmedFingerprint)) {
          // Torn write: the fingerprint moved during the read, so the fetched
          // contents describe no settled file version. Neither flag nor
          // strike — the next cycle retries.
          return;
        }
        fingerprintRef.current = confirmedFingerprint;
        if (
          textStateRef.current.contents !== payload.contents ||
          textStateRef.current.status !== "loaded"
        ) {
          updateTextState({ status: "loaded", contents: payload.contents });
        }
        updateDiskStatus("current");
      } catch (error) {
        if (isCurrentPoll()) recordDivergenceStrike(fileStatErrorKind(error));
      } finally {
        checkInFlight = false;
      }
    };

    const clearPollTimer = () => {
      if (pollTimerId !== null) {
        window.clearTimeout(pollTimerId);
        pollTimerId = null;
      }
    };
    const scheduleNextPoll = () => {
      clearPollTimer();
      if (cancelled || document.visibilityState === "hidden") return;

      const interval = document.hasFocus()
        ? FOREGROUND_ARTIFACT_POLL_INTERVAL_MS
        : BACKGROUND_ARTIFACT_POLL_INTERVAL_MS;
      pollTimerId = window.setTimeout(() => {
        pollTimerId = null;
        void checkForDiskChange().finally(scheduleNextPoll);
      }, interval);
    };
    const handleFocus = () => {
      clearPollTimer();
      void checkForDiskChange().finally(scheduleNextPoll);
    };
    const handleBlur = () => {
      scheduleNextPoll();
    };
    const handleVisibilityChange = () => {
      clearPollTimer();
      if (document.visibilityState !== "hidden") {
        void checkForDiskChange().finally(scheduleNextPoll);
      }
    };

    scheduleNextPoll();
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      pollGenerationRef.current += 1;
      clearPollTimer();
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    artifact.resolvedPath,
    artifact.revision,
    recordDivergenceStrike,
    remoteHost,
    updateDiskStatus,
    updateTextState,
    viewMode,
  ]);

  return (
    <Artifact className="h-full min-h-0 flex-1 rounded-none border-0 shadow-none">
      <ArtifactHeader>
        <div className="flex min-w-0 items-center gap-2">
          {viewMode === "image" ? (
            <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <ArtifactTitle title={artifact.resolvedPath}>
            {artifact.filename}
          </ArtifactTitle>
        </div>
        <ArtifactActions>
          {remoteHost == null && viewMode !== "image" ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={markdownView}
              onValueChange={(value) => {
                if (value === "preview" || value === "raw") {
                  setMarkdownView(value);
                }
              }}
              className="mr-1"
            >
              <ToggleGroupItem value="preview" className="px-3">
                {t("artifactViewer.viewPreview")}
              </ToggleGroupItem>
              <ToggleGroupItem value="raw" className="px-3">
                {t("artifactViewer.viewCode")}
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          {/* "Open in editor" and "Reveal in Finder" are the same kind of
              hand-off to the OS, so they share one menu rather than competing
              as two similar folder-ish glyphs next to Close. The trigger stays
              a neutral `⋯`: it opens a set of choices rather than performing
              one, so borrowing either destination's glyph would misreport what
              the button does. The distinguishing icons live on the menu items,
              where each one labels a single action — ExternalLink for the
              hand-off out of the app, FolderOpen for the reveal in place. */}
          {remoteHost == null ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ArtifactAction
                  icon={EllipsisIcon}
                  tooltip={t("artifactViewer.fileActions")}
                  label={t("artifactViewer.fileActions")}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    void openResolvedPath(artifact.resolvedPath).catch(
                      () => {},
                    );
                  }}
                >
                  <ExternalLinkIcon />
                  {t("artifactViewer.openExternally")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void revealInFileManager(artifact.resolvedPath).catch(
                      () => {},
                    );
                  }}
                >
                  <FolderOpenIcon />
                  {t(revealLabelKey)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <ArtifactAction
            icon={XIcon}
            tooltip={t("artifactViewer.close")}
            label={t("artifactViewer.close")}
            onClick={onClose}
          />
        </ArtifactActions>
      </ArtifactHeader>

      {remoteHost == null && diskStatus === "diverged" ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
        >
          <span>
            {divergedKind === "missing"
              ? t("artifactViewer.fileDeleted")
              : t("artifactViewer.fileUnreadable")}
          </span>
          {/* A deleted file has nothing to reload; the strip is the whole
              answer. Polling keeps retrying, so if the file reappears the
              view heals without user action. */}
          {divergedKind !== "missing" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => setRetryRevision((revision) => revision + 1)}
            >
              {t("artifactViewer.reload")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Dim the stale body while diverged so the warning strip reads as
          describing the content, not competing with it. "checking" stays at
          full opacity — routine polls must not flicker the view. */}
      <div
        className={cn(
          "flex-1 overflow-auto",
          remoteHost == null && diskStatus === "diverged" && "opacity-60",
        )}
      >
        {remoteHost != null ? (
          <RemoteArtifactBody artifact={artifact} host={remoteHost} />
        ) : viewMode === "image" ? (
          <ImageBody
            artifact={artifact}
            src={imageSrc}
            onLoad={(loadedSrc) => {
              if (loadedSrc !== imageSrc) return;
              loadedImageSrcRef.current = loadedSrc;
              const pending = pendingImageRef.current;
              if (pending?.src !== loadedSrc) return;
              fingerprintRef.current = pending.fingerprint;
              pendingImageRef.current = null;
              updateDiskStatus("current");
            }}
            onLoadError={(failedSrc) => {
              if (failedSrc !== imageSrc) return;
              loadedImageSrcRef.current = null;
              pendingImageRef.current = null;
              // The rendered image failed to decode, so the view is already
              // visibly broken — no grace period applies. The file may still
              // exist (truncated, corrupt), so this is "other", not "missing".
              flagDiverged("other");
            }}
          />
        ) : (
          <MarkdownBody
            markdownView={markdownView}
            textState={renderedTextState}
            onOpenExternally={() => {
              void openResolvedPath(artifact.resolvedPath).catch(() => {});
            }}
          />
        )}
      </div>
    </Artifact>
  );
}

function RemoteArtifactBody({
  artifact,
  host,
}: {
  artifact: OpenArtifact;
  host: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <div
      data-testid="remote-artifact-placeholder"
      className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <div className="flex min-w-0 max-w-full items-center gap-2 text-sm text-foreground">
        <FileTextIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate">{artifact.filename}</span>
        <span className="shrink-0 rounded-full border border-border/80 bg-muted/40 px-1.5 py-px text-xs text-muted-foreground">
          {t("remoteSessionGuards.onHostChip", { host })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("remoteSessionGuards.viewerUnavailable", { host })}
      </p>
    </div>
  );
}

function artifactImageSrc(path: string, revision: number): string {
  const assetSrc = convertFileSrc(path, "asset");
  return revision > 0 ? `${assetSrc}?rev=${revision}` : assetSrc;
}

function preloadArtifactImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Artifact image failed to load"));
    image.src = src;
  });
}

function ImageBody({
  artifact,
  src,
  onLoad,
  onLoadError,
}: {
  artifact: OpenArtifact;
  src: string;
  onLoad: (src: string) => void;
  onLoadError: (src: string) => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex items-center justify-center p-4">
      <img
        src={src}
        alt={t("artifactViewer.imageAlt", { filename: artifact.filename })}
        className="h-auto max-w-full rounded-md"
        onLoad={() => onLoad(src)}
        onError={() => onLoadError(src)}
      />
    </div>
  );
}

function MarkdownBody({
  markdownView,
  textState,
  onOpenExternally,
}: {
  markdownView: MarkdownView;
  textState: TextState;
  onOpenExternally: () => void;
}) {
  const { t } = useTranslation("chat");

  if (textState.status === "loading") {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner aria-label={t("artifactViewer.loading")} />
      </div>
    );
  }
  if (textState.status === "error") {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-3 px-4">
        <p className="text-center text-sm text-muted-foreground">
          {t("artifactViewer.loadError")}
        </p>
        <Button variant="outline" size="sm" onClick={onOpenExternally}>
          {t("artifactViewer.openExternally")}
        </Button>
      </div>
    );
  }

  if (markdownView === "raw") {
    return (
      // CodeBlock's own `pre` already pads by 12px, so the container only adds
      // the remaining 4px. That lands the line-number gutter at the same 16px
      // inset as the Preview body below, and the two views stop shifting
      // horizontally when you toggle between them. Padding both layers (the
      // old `p-4`) stacked to 28px before the gutter even started.
      <CodeBlock
        code={textState.contents}
        language="markdown"
        showLineNumbers
        transparentBackground
        className="px-1"
      />
    );
  }

  // Body copy at the app's Body scale (DESIGN.md §3), matching the agent and
  // skill detail pages. Heading scale comes from the shared markdown type
  // scale in shared/ui/ai-elements/message.tsx, so it is not restated here.
  return (
    <div className="px-4 py-3">
      <MessageResponse
        className="min-w-0 text-sm leading-relaxed"
        imageRenderer={MarkdownImage}
      >
        {textState.contents}
      </MessageResponse>
    </div>
  );
}
