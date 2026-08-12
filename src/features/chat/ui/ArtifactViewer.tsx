import { convertFileSrc } from "@tauri-apps/api/core";
import {
  EllipsisIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  ImageIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { readTextFile } from "@/shared/api/system";
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

interface TextState {
  status: "loading" | "loaded" | "error";
  contents: string;
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

  // Load text contents for markdown. Images render straight from the path.
  useEffect(() => {
    if (viewMode === "image") return;
    let cancelled = false;
    setTextState({ status: "loading", contents: "" });
    void readTextFile(artifact.resolvedPath)
      .then((payload) => {
        if (cancelled) return;
        setTextState({ status: "loaded", contents: payload.contents });
      })
      .catch(() => {
        if (cancelled) return;
        setTextState({ status: "error", contents: "" });
      });
    return () => {
      cancelled = true;
    };
    // Depend on the artifact object, not just the path: the store creates a
    // fresh object (with a bumped revision) when the same path is re-opened
    // after the agent re-edits it, and the contents must be re-read then.
  }, [artifact, viewMode]);

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

      <div className="flex-1 overflow-auto">
        {viewMode === "image" ? (
          <ImageBody artifact={artifact} />
        ) : (
          <MarkdownBody
            markdownView={markdownView}
            textState={textState}
            onOpenExternally={() => {
              void openResolvedPath(artifact.resolvedPath).catch(() => {});
            }}
          />
        )}
      </div>
    </Artifact>
  );
}

function ImageBody({ artifact }: { artifact: OpenArtifact }) {
  const { t } = useTranslation("chat");
  const src = useMemo(() => {
    const assetSrc = convertFileSrc(artifact.resolvedPath, "asset");
    // Re-opening the same path (agent re-edited the open image) must bypass
    // the webview's cache for the unchanged asset URL.
    return artifact.revision > 0
      ? `${assetSrc}?rev=${artifact.revision}`
      : assetSrc;
  }, [artifact.resolvedPath, artifact.revision]);
  return (
    <div className="flex items-center justify-center p-4">
      <img
        src={src}
        alt={t("artifactViewer.imageAlt", { filename: artifact.filename })}
        className="h-auto max-w-full rounded-md"
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
