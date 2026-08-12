import type { ComponentProps, ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArchiveRestore,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Mail,
  MailOpen,
  Pencil,
  PinIcon,
} from "lucide-react";
import { toast } from "sonner";

import { createSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";
import { cn } from "@/shared/lib/cn";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/shared/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/shared/ui/dropdown-menu";
import { SIDEBAR_RAISED_MENU_CONTENT_CLASS } from "@/shared/ui/sidebar-tokens";

export const SESSION_ACTIONS_MENU_CONTENT_CLASS = cn(
  SIDEBAR_RAISED_MENU_CONTENT_CLASS,
  "w-52",
);

const SESSION_ACTIONS_MENU_SEPARATOR_CLASS =
  "mx-2 bg-popover-raised-muted-foreground/35";

type MenuItemComponent = ComponentType<{
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}>;

type MenuLabelComponent = ComponentType<{
  children?: ReactNode;
  className?: string;
}>;

type MenuSeparatorComponent = ComponentType<{
  className?: string;
}>;

export interface SessionActionsMenuProps {
  sessionId: string;
  onClose?: () => void;
  archived?: boolean;
  hasUnread?: boolean;
  isPinned?: boolean;
  isPinning?: boolean;
  /** Whether every chat in the current selection is already pinned to home. */
  isSelectionPinned?: boolean;
  isOpenInWindow?: boolean;
  selectionCount?: number;
  selectionActionsDisabled?: boolean;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onTogglePin?: () => void;
  onRename?: () => void;
  onOpenInWindow?: () => void;
  /** Bulk variant of open-in-window; opens every selected chat. */
  onOpenSelectedInWindows?: () => void;
  onDuplicate?: () => void;
  editProjectLabel?: string;
  onEditProject?: () => void;
  showCopyLink?: boolean;
  onExport?: () => void;
  /** Bulk variant of export; exports every selected chat. */
  onExportSelected?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
}

function SessionActionsMenuItems({
  sessionId,
  Item,
  Label,
  Separator,
  onClose,
  archived = false,
  hasUnread = false,
  isPinned = false,
  isPinning = false,
  isSelectionPinned = false,
  isOpenInWindow = false,
  selectionCount = 0,
  selectionActionsDisabled = false,
  onMarkRead,
  onMarkUnread,
  onTogglePin,
  onRename,
  onOpenInWindow,
  onOpenSelectedInWindows,
  onDuplicate,
  editProjectLabel,
  onEditProject,
  showCopyLink = true,
  onExport,
  onExportSelected,
  onArchive,
  onRestore,
}: SessionActionsMenuProps & {
  Item: MenuItemComponent;
  Label: MenuLabelComponent;
  Separator: MenuSeparatorComponent;
}) {
  const { t } = useTranslation(["sessions", "sidebar", "common"]);
  const appliesToSelection = selectionCount > 1;

  const invoke = (action?: () => void) => {
    onClose?.();
    action?.();
  };

  const handleCopyLink = () => {
    const link = createSessionDeepLink(sessionId);
    onClose?.();
    void (async () => {
      if (window.__TAURI_INTERNALS__) {
        const { writeText } = await import(
          "@tauri-apps/plugin-clipboard-manager"
        );
        await writeText(link);
        return;
      }

      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await clipboard.writeText(link);
    })()
      .then(() => toast.success(t("sidebar:actions.linkCopied")))
      .catch((error) => {
        console.error("Failed to copy session link:", error);
        toast.error(t("sidebar:actions.copyLinkFailed"));
      });
  };

  const markAction = hasUnread ? onMarkRead : onMarkUnread;
  const showAttentionGroup =
    !archived && (markAction != null || onTogglePin != null);
  // Single-chat-only actions are hidden (not disabled) during multi-select;
  // bulk-capable actions stay when their bulk callback exists.
  const showRenameItem = onRename != null && !appliesToSelection;
  const showOpenInWindowItem =
    onOpenInWindow != null &&
    (!appliesToSelection || onOpenSelectedInWindows != null);
  const showDuplicateItem = onDuplicate != null && !appliesToSelection;
  const showEditProjectItem = onEditProject != null && !appliesToSelection;
  const showCopyLinkItem = showCopyLink && !appliesToSelection;
  const showExportItem =
    onExport != null && (!appliesToSelection || onExportSelected != null);
  const showRegularActions =
    !archived &&
    (showRenameItem ||
      showOpenInWindowItem ||
      showDuplicateItem ||
      showEditProjectItem ||
      showCopyLinkItem ||
      showExportItem);
  const showArchivedActions = archived && onExport != null;
  const showMiddleGroup = showRegularActions || showArchivedActions;
  const showLifecycleGroup = archived ? onRestore != null : onArchive != null;

  return (
    <>
      {appliesToSelection ? (
        <>
          <Label className="text-sm font-medium text-muted-foreground">
            {t("sessions:history.selectedContext", {
              count: selectionCount,
              displayCount: selectionCount,
            })}
          </Label>
          <Separator className={SESSION_ACTIONS_MENU_SEPARATOR_CLASS} />
        </>
      ) : null}

      {showAttentionGroup ? (
        <>
          {markAction ? (
            <Item
              onClick={() => invoke(markAction)}
              disabled={appliesToSelection && selectionActionsDisabled}
            >
              {hasUnread ? (
                <MailOpen className="size-3.5" />
              ) : (
                <Mail className="size-3.5" />
              )}
              {t(
                hasUnread
                  ? "sidebar:actions.markRead"
                  : "sidebar:actions.markUnread",
              )}
            </Item>
          ) : null}
          {onTogglePin ? (
            <Item onClick={() => invoke(onTogglePin)} disabled={isPinning}>
              <PinIcon
                className="size-3.5"
                fill={
                  (appliesToSelection ? isSelectionPinned : isPinned)
                    ? "currentColor"
                    : "none"
                }
              />
              {appliesToSelection
                ? isSelectionPinned
                  ? t("common:actions.unpinChats")
                  : isPinning
                    ? t("common:actions.pinningChat")
                    : t("common:actions.pinChats")
                : isPinned
                  ? t("common:actions.unpinChat")
                  : isPinning
                    ? t("common:actions.pinningChat")
                    : t("common:actions.pinChat")}
            </Item>
          ) : null}
        </>
      ) : null}

      {showAttentionGroup && (showMiddleGroup || showLifecycleGroup) ? (
        <Separator className={SESSION_ACTIONS_MENU_SEPARATOR_CLASS} />
      ) : null}

      {showMiddleGroup ? (
        <>
          {!archived ? (
            <>
              {showRenameItem ? (
                <Item onClick={() => invoke(onRename)}>
                  <Pencil className="size-3.5" />
                  {t("common:actions.rename")}
                </Item>
              ) : null}
              {showOpenInWindowItem ? (
                <Item
                  onClick={() =>
                    invoke(
                      appliesToSelection
                        ? onOpenSelectedInWindows
                        : onOpenInWindow,
                    )
                  }
                  disabled={appliesToSelection && selectionActionsDisabled}
                >
                  <ExternalLink className="size-3.5" />
                  {appliesToSelection
                    ? t("sidebar:actions.openInNewWindows")
                    : isOpenInWindow
                      ? t("sessions:card.openWindow")
                      : t("sessions:card.openInNewWindow")}
                </Item>
              ) : null}
              {showDuplicateItem ? (
                <Item onClick={() => invoke(onDuplicate)}>
                  <CopyPlus className="size-3.5" />
                  {t("common:actions.duplicate")}
                </Item>
              ) : null}
              {showEditProjectItem ? (
                <Item onClick={() => invoke(onEditProject)}>
                  <Pencil className="size-3.5" />
                  {editProjectLabel}
                </Item>
              ) : null}
              {showCopyLinkItem ? (
                <Item onClick={handleCopyLink}>
                  <Copy className="size-3.5" />
                  {t("sidebar:actions.copyLink")}
                </Item>
              ) : null}
            </>
          ) : null}
          {showExportItem ? (
            <Item
              onClick={() =>
                invoke(appliesToSelection ? onExportSelected : onExport)
              }
              disabled={appliesToSelection && selectionActionsDisabled}
            >
              <Download className="size-3.5" />
              {t("sessions:card.export")}
            </Item>
          ) : null}
        </>
      ) : null}

      {showMiddleGroup && showLifecycleGroup ? (
        <Separator className={SESSION_ACTIONS_MENU_SEPARATOR_CLASS} />
      ) : null}

      {archived ? (
        onRestore ? (
          <Item onClick={() => invoke(onRestore)}>
            <ArchiveRestore className="size-3.5" />
            {t("common:actions.restore")}
          </Item>
        ) : null
      ) : onArchive ? (
        <Item
          onClick={() => invoke(onArchive)}
          disabled={appliesToSelection && selectionActionsDisabled}
        >
          <Archive className="size-3.5" />
          {t("common:actions.archive")}
        </Item>
      ) : null}
    </>
  );
}

export function SessionActionsMenuContent({
  className,
  align = "start",
  alignOffset = -4,
  sideOffset = 4,
  ...props
}: SessionActionsMenuProps &
  Omit<ComponentProps<typeof DropdownMenuContent>, "children" | "variant">) {
  return (
    <DropdownMenuContent
      variant="raised"
      align={align}
      alignOffset={alignOffset}
      sideOffset={sideOffset}
      className={cn(SESSION_ACTIONS_MENU_CONTENT_CLASS, className)}
    >
      <SessionActionsMenuItems
        {...props}
        Item={DropdownMenuItem}
        Label={DropdownMenuLabel}
        Separator={DropdownMenuSeparator}
      />
    </DropdownMenuContent>
  );
}

export function SessionActionsContextMenuContent({
  className,
  // Content-level props must be named to reach ContextMenuContent: the rest
  // spread below feeds SessionActionsMenuItems, which destructures a fixed set
  // and has no rest spread of its own, so anything not pulled out here is
  // silently dropped instead of reaching Radix.
  onCloseAutoFocus,
  ...props
}: SessionActionsMenuProps &
  Omit<ComponentProps<typeof ContextMenuContent>, "children" | "variant">) {
  return (
    <ContextMenuContent
      variant="raised"
      onCloseAutoFocus={onCloseAutoFocus}
      className={cn(SESSION_ACTIONS_MENU_CONTENT_CLASS, className)}
    >
      <SessionActionsMenuItems
        {...props}
        Item={ContextMenuItem}
        Label={ContextMenuLabel}
        Separator={ContextMenuSeparator}
      />
    </ContextMenuContent>
  );
}
