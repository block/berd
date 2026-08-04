import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRight } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FileContextMenu } from "@/shared/ui/file-context-menu";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import type { ViewableArtifactTarget } from "@/features/chat/lib/artifactViewerTypes";

/**
 * Inline "open this in the viewer" affordances, rendered in the transcript at
 * the point where the agent produced the files.
 *
 * Why this exists: re-entry used to depend on how a run happened to render.
 * Chain and agent-work headers each had their own "View" action that only
 * appeared when the run touched exactly ONE viewable file, so the busiest runs
 * — where getting back to a document matters most — offered no way back once
 * the panel was closed, and the same file surfaced as a different-looking
 * control depending on grouping. Chips are the single re-entry control: one per
 * file, any count, anchored to the message rather than a card's expanded state.
 *
 * These are deliberately *not* gated by the auto-open importance policy. That
 * policy decides what may interrupt you; this is manual re-entry, where the
 * click is the intent. A screenshot or a `SKILL.md` still gets a chip.
 */
export function ArtifactChips({
  artifacts,
  groupThreshold = 3,
  className,
}: {
  artifacts: readonly ViewableArtifactTarget[];
  /**
   * Above this count, only the first `groupThreshold` chips render and the
   * rest hide behind a "+N more" toggle, so a run that touched a dozen files
   * doesn't build a wall of pills.
   */
  groupThreshold?: number;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const { openInApp, openResolvedPath } = useArtifactActionsContext();
  const [expanded, setExpanded] = useState(false);

  if (artifacts.length === 0) return null;

  const overflowing = artifacts.length > groupThreshold;
  const visible =
    overflowing && !expanded ? artifacts.slice(0, groupThreshold) : artifacts;
  const hiddenCount = artifacts.length - visible.length;

  return (
    <div
      data-role="artifact-chips"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {visible.map((artifact) => (
        <FileContextMenu
          key={artifact.path}
          path={artifact.path}
          onOpenInViewer={() =>
            void openInApp(artifact.path, artifact.filename)
          }
          onOpenExternally={() =>
            void openResolvedPath(artifact.path).catch(() => {})
          }
        >
          <Button
            type="button"
            variant="outline"
            size="xxs"
            onClick={() => void openInApp(artifact.path, artifact.filename)}
            tooltip={artifact.path}
            aria-label={t("artifactChips.open", { name: artifact.filename })}
            leftIcon={<PanelRight aria-hidden="true" />}
            className="min-w-0"
          >
            <span className="max-w-[14rem] truncate">{artifact.filename}</span>
          </Button>
        </FileContextMenu>
      ))}

      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          flush
          size="xxs"
          onClick={() => setExpanded(true)}
        >
          {t("artifactChips.more", { count: hiddenCount })}
        </Button>
      ) : null}
    </div>
  );
}
