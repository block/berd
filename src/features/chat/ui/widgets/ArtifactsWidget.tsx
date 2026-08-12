import { useTranslation } from "react-i18next";
import {
  IconFile,
  IconFileCode,
  IconFileText,
  IconJson,
  IconMarkdown,
  IconPhoto,
  IconFileDescription,
} from "@tabler/icons-react";
import { FileContextMenu } from "@/shared/ui/file-context-menu";
import {
  useArtifactActionsContext,
  useSessionArtifacts,
  type SessionArtifact,
} from "../../hooks/ArtifactPolicyContext";
import { isViewableArtifact } from "../../lib/artifactViewerTypes";
import { Widget } from "./Widget";

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".html",
  ".py",
  ".rb",
  ".rs",
  ".go",
  ".java",
  ".sh",
  ".sql",
  ".yaml",
  ".yml",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

function getArtifactIcon(artifact: SessionArtifact) {
  const ext = artifact.filename.includes(".")
    ? `.${artifact.filename.split(".").pop()?.toLowerCase()}`
    : "";

  if (ext === ".json") return IconJson;
  if (ext === ".md" || ext === ".mdx") return IconMarkdown;
  if (ext === ".txt") return IconFileText;
  if (IMAGE_EXTENSIONS.has(ext)) return IconPhoto;
  if (CODE_EXTENSIONS.has(ext)) return IconFileCode;
  return IconFile;
}

interface ArtifactsWidgetProps {
  isOpen: boolean;
  onToggleOpen: () => void;
}

export function ArtifactsWidget({
  isOpen,
  onToggleOpen,
}: ArtifactsWidgetProps) {
  const { t } = useTranslation("chat");
  const artifacts = useSessionArtifacts();
  const { openInApp, openResolvedPath } = useArtifactActionsContext();

  const handleOpen = (artifact: SessionArtifact) => {
    void openInApp(artifact.resolvedPath, artifact.filename);
  };

  if (artifacts.length === 0) {
    return null;
  }

  return (
    <Widget
      title={t("contextPanel.widgets.artifacts")}
      icon={<IconFileDescription className="size-3.5" />}
      isOpen={isOpen}
      onToggleOpen={onToggleOpen}
      action={
        <span className="text-xxs text-muted-foreground">
          {artifacts.length}
        </span>
      }
      flush
    >
      {artifacts.map((artifact) => {
        const Icon = getArtifactIcon(artifact);
        return (
          <FileContextMenu
            key={artifact.resolvedPath}
            path={artifact.resolvedPath}
            onOpenInViewer={
              isViewableArtifact(artifact.resolvedPath)
                ? () => void openInApp(artifact.resolvedPath, artifact.filename)
                : undefined
            }
            onOpenExternally={
              // For viewable files the row's primary click opens the in-app
              // viewer, so external open stays one right-click away. For
              // everything else the primary click already opens externally.
              isViewableArtifact(artifact.resolvedPath)
                ? () =>
                    void openResolvedPath(artifact.resolvedPath).catch(() => {})
                : undefined
            }
          >
            <button
              type="button"
              className="relative flex w-full select-none items-center gap-2 rounded-sm px-4 py-1.5 text-left before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-border/70 before:content-['']"
              onClick={() => handleOpen(artifact)}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm text-foreground">
                {artifact.filename}
              </span>
            </button>
          </FileContextMenu>
        );
      })}
    </Widget>
  );
}
