import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { getPlatform } from "@/shared/lib/platform";

const revealLabel = `labels.revealInFileManager_${getPlatform()}` as const;

interface FileContextMenuProps {
  path: string;
  children: ReactNode;
  /**
   * When provided, adds an "Open in viewer" item. Callers pass this only for
   * files that can be previewed in the app (markdown, images).
   */
  onOpenInViewer?: () => void;
  /**
   * When provided, adds an "Open in editor" item. Callers pass this when the
   * row's primary click opens the in-app viewer, so external open stays one
   * right-click away as a secondary action.
   */
  onOpenExternally?: () => void;
}

export function FileContextMenu({
  path,
  children,
  onOpenInViewer,
  onOpenExternally,
}: FileContextMenuProps) {
  const { t } = useTranslation("common");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {onOpenInViewer ? (
          <ContextMenuItem onSelect={() => onOpenInViewer()}>
            {t("labels.openInViewer")}
          </ContextMenuItem>
        ) : null}
        {onOpenExternally ? (
          <ContextMenuItem onSelect={() => onOpenExternally()}>
            {t("labels.openInEditor")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={() => void navigator.clipboard.writeText(path)}
        >
          {t("labels.copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void revealInFileManager(path)}>
          {t(revealLabel)}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
