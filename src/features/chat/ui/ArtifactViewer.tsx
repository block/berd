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
import { readTextFile, statFile } from "@/shared/api/system";
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
}

const ARTIFACT_POLL_INTERVAL_MS = 1_500;

function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint,
): boolean {
  return (
    left.byteSize === right.byteSize && left.modifiedAtNs === right.modifiedAtNs
  );
}

export function ArtifactViewer({ artifact, onClose }: ArtifactViewerProps) {
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
  const [imageDiskRevision, setImageDiskRevision] = useState(0);
  const imageDiskRevisionRef = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const renderedTextState: TextState =
    displayedPathRef.current === artifact.resolvedPath
      ? textState
      : { status: "loading", contents: "" };
  const contentReadRevision = artifact.revision;
  const refreshGenerationRef = useRef(0);

  const updateTextState = useCallback((next: TextState) => {
    textStateRef.current = next;
    setTextState(next);
  }, []);
  const updateDiskStatus = useCallback((next: DiskStatus) => {
    diskStatusRef.current = next;
    setDiskStatus(next);
  }, []);

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
    let cancelled = false;
    const refreshGeneration = ++refreshGenerationRef.current;
    const isCurrentRefresh = () =>
      !cancelled && refreshGeneration === refreshGenerationRef.current;
    const pathChanged = displayedPathRef.current !== artifact.resolvedPath;
    if (pathChanged) {
      displayedPathRef.current = artifact.resolvedPath;
      fingerprintRef.current = null;
      updateTextState({ status: "loading", contents: "" });
      imageDiskRevisionRef.current = 0;
      setImageDiskRevision(0);
    } else if (
      viewMode !== "image" &&
      textStateRef.current.status !== "loaded"
    ) {
      updateTextState({ status: "loading", contents: "" });
    }
    updateDiskStatus("checking");

    // Reading this value makes the ACP-driven revision an explicit input to
    // this request even though only its change, not its numeric value, matters.
    void contentReadRevision;
    void (async () => {
      try {
        const before = await statFile(artifact.resolvedPath);
        if (!isCurrentRefresh()) return;

        if (viewMode === "image") {
          fingerprintRef.current = before;
          if (retryRevision > 0) {
            imageDiskRevisionRef.current += 1;
            setImageDiskRevision(imageDiskRevisionRef.current);
          }
          updateDiskStatus("current");
          return;
        }

        const payload = await readTextFile(artifact.resolvedPath);
        const after = await statFile(artifact.resolvedPath);
        if (!isCurrentRefresh()) return;
        if (!sameFingerprint(before, after)) {
          updateDiskStatus("diverged");
          return;
        }

        fingerprintRef.current = after;
        if (
          textStateRef.current.contents !== payload.contents ||
          textStateRef.current.status !== "loaded"
        ) {
          updateTextState({ status: "loaded", contents: payload.contents });
        }
        updateDiskStatus("current");
      } catch {
        if (!isCurrentRefresh()) return;
        if (textStateRef.current.status === "loaded") {
          updateDiskStatus("diverged");
        } else {
          updateTextState({ status: "error", contents: "" });
          updateDiskStatus("diverged");
        }
      }
    })();

    return () => {
      cancelled = true;
      refreshGenerationRef.current += 1;
    };
  }, [
    artifact.resolvedPath,
    contentReadRevision,
    retryRevision,
    updateDiskStatus,
    updateTextState,
    viewMode,
  ]);

  // Tool events cannot account for shell writes, delegated subagents, or
  // external editors. Poll the one open file while this document is visible,
  // including an immediate check on return from the background.
  useEffect(() => {
    let cancelled = false;
    let checkInFlight = false;

    const checkForDiskChange = async () => {
      if (document.visibilityState === "hidden" || checkInFlight) {
        return;
      }
      const refreshGeneration = ++refreshGenerationRef.current;
      const isCurrentRefresh = () =>
        !cancelled && refreshGeneration === refreshGenerationRef.current;
      checkInFlight = true;
      try {
        const fingerprint = await statFile(artifact.resolvedPath);
        if (!isCurrentRefresh()) return;
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
          const candidateRevision = imageDiskRevisionRef.current + 1;
          await preloadArtifactImage(artifact.resolvedPath, candidateRevision);
          if (!isCurrentRefresh()) return;
          fingerprintRef.current = fingerprint;
          imageDiskRevisionRef.current = candidateRevision;
          setImageDiskRevision(candidateRevision);
          updateDiskStatus("current");
          return;
        }

        const payload = await readTextFile(artifact.resolvedPath);
        if (!isCurrentRefresh()) return;
        const confirmedFingerprint = await statFile(artifact.resolvedPath);
        if (
          !isCurrentRefresh() ||
          !sameFingerprint(fingerprint, confirmedFingerprint)
        ) {
          updateDiskStatus("diverged");
          return;
        }
        fingerprintRef.current = confirmedFingerprint;
        if (textStateRef.current.contents !== payload.contents) {
          updateTextState({ status: "loaded", contents: payload.contents });
        }
        updateDiskStatus("current");
      } catch {
        if (isCurrentRefresh()) updateDiskStatus("diverged");
      } finally {
        checkInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        void checkForDiskChange();
      }
    };
    const intervalId = window.setInterval(
      () => void checkForDiskChange(),
      ARTIFACT_POLL_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      refreshGenerationRef.current += 1;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [artifact.resolvedPath, updateDiskStatus, updateTextState, viewMode]);

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
          {viewMode !== "image" ? (
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
                  void openResolvedPath(artifact.resolvedPath).catch(() => {});
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
          <ArtifactAction
            icon={XIcon}
            tooltip={t("artifactViewer.close")}
            label={t("artifactViewer.close")}
            onClick={onClose}
          />
        </ArtifactActions>
      </ArtifactHeader>

      {diskStatus === "diverged" ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
        >
          <span>{t("artifactViewer.diskDiverged")}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => setRetryRevision((revision) => revision + 1)}
          >
            {t("artifactViewer.reload")}
          </Button>
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {viewMode === "image" ? (
          <ImageBody
            artifact={artifact}
            diskRevision={imageDiskRevision}
            onLoadError={() => updateDiskStatus("diverged")}
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

function artifactImageSrc(path: string, revision: number): string {
  const assetSrc = convertFileSrc(path, "asset");
  return revision > 0 ? `${assetSrc}?rev=${revision}` : assetSrc;
}

function preloadArtifactImage(path: string, revision: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Artifact image failed to load"));
    image.src = artifactImageSrc(path, revision);
  });
}

function ImageBody({
  artifact,
  diskRevision,
  onLoadError,
}: {
  artifact: OpenArtifact;
  diskRevision: number;
  onLoadError: () => void;
}) {
  const { t } = useTranslation("chat");
  const src = useMemo(() => {
    // Re-opening or detecting an external write to the same path must bypass
    // the webview's cache for the unchanged asset URL.
    return artifactImageSrc(
      artifact.resolvedPath,
      artifact.revision + diskRevision,
    );
  }, [artifact.resolvedPath, artifact.revision, diskRevision]);
  return (
    <div className="flex items-center justify-center p-4">
      <img
        src={src}
        alt={t("artifactViewer.imageAlt", { filename: artifact.filename })}
        className="h-auto max-w-full rounded-md"
        onError={onLoadError}
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
