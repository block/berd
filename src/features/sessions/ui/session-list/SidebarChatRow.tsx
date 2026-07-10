import {
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  Archive,
  Check,
  CopyPlus,
  ExternalLink,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { IconGitBranch, IconPin } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";
import {
  focusSessionWindow,
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowSupport } from "@/features/chat/hooks/useSessionWindowSupport";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { isMultiSelectModifier } from "@/features/sessions/lib/sessionSelection";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import {
  clearPointerDragClickSuppression,
  hasExceededPointerDragThreshold,
  isPrimaryPointerButton,
  schedulePointerDragClickSuppressionReset,
} from "@/features/sidebar/lib/pointerDrag";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_CHAT_ROW_DENSITY_CLASSES,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
  type SidebarChatRowDensity,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatMenuIcon } from "./SidebarChatMenuIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { Input } from "@/shared/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SidebarUnreadDot } from "./SidebarUnreadDot";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { toast } from "sonner";

const INACTIVE_CHAT_ROW_CLASS = cn(
  "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const ACTIVE_CHAT_ROW_CLASS = cn(
  "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const SELECTED_CHAT_ROW_CLASS = cn(
  "bg-sidebar-accent text-sidebar-foreground ring-1 ring-inset ring-sidebar-border/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);

/**
 * Compact single-unit relative time for sidebar chat rows: `5m`, `3h`, `2d`,
 * `1w`, `4mo`, `2y`. Under a minute renders as `now`.
 */
export function formatSidebarChatTimestamp(
  value: string | null | undefined,
  options: { now?: Date } = {},
): string {
  const trimmedValue = value?.trim();
  if (!trimmedValue) return "";

  const date = new Date(trimmedValue);
  if (!Number.isFinite(date.getTime())) return "";

  const now = options.now ?? new Date();
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${Math.max(years, 1)}y`;
}

type MenuItemComponent = ComponentType<{
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}>;

type MenuLabelComponent = ComponentType<{
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}>;

type MenuSeparatorComponent = ComponentType<{
  className?: string;
}>;

type RenderMenuItemsOptions = {
  Item: MenuItemComponent;
  Label: MenuLabelComponent;
  Separator: MenuSeparatorComponent;
  itemClassName?: string;
  itemStyle?: CSSProperties;
};

interface SidebarChatRowProps {
  id: string;
  title: string;
  /** Current Git branch for this chat; only passed when the sidebar branch setting is enabled. */
  branchName?: string;
  /** Latest visible chat activity. Rendered as a compact relative timestamp on the row's right edge; hidden on hover when the row menu takes its place. */
  activityAt?: string | null;
  showTimestamp?: boolean;
  isActive: boolean;
  isRunning?: boolean;
  hasUnread?: boolean;
  isPinned?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectedSessionIds?: Set<string>;
  className?: string;
  contentPaddingClassName?: string;
  nested?: boolean;
  density?: SidebarChatRowDensity;
  showLeadingIcon?: boolean;
  leadingIconTestId?: string;
  leadingIcon?: ReactNode;
  menuContentClassName?: string;
  menuItemClassName?: string;
  menuItemStyle?: CSSProperties;
  menuLabelClassName?: string;
  menuLabelStyle?: CSSProperties;
  flatProjectName?: string;
  flatProjectIcon?: string | null;
  flatProjectColor?: string | null;
  /** Project the chat currently lives in, or null when it sits in Recents. */
  currentProjectId?: string | null;
  onEditProject?: (projectId: string) => void;
  onSelect?: (id: string) => void;
  onSelectionClear?: () => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onFork?: (id: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onMarkRead?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  renderExtraMenuItems?: (options: RenderMenuItemsOptions) => ReactNode;
}

export function SidebarChatRow({
  id,
  title,
  branchName,
  activityAt,
  showTimestamp = true,
  isActive,
  isRunning = false,
  hasUnread = false,
  isPinned = false,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectedSessionIds,
  className,
  contentPaddingClassName,
  nested = false,
  density = "default",
  showLeadingIcon = true,
  leadingIconTestId,
  leadingIcon,
  menuContentClassName,
  menuItemClassName,
  menuItemStyle,
  menuLabelClassName,
  menuLabelStyle,
  flatProjectName,
  flatProjectIcon,
  flatProjectColor,
  currentProjectId = null,
  onEditProject,
  onSelect,
  onSelectionClear,
  onSelectionChange,
  onRename,
  onFork,
  onArchive,
  onArchiveSelected,
  onPinSelectedToHome,
  isPinningSelectedToHome = false,
  onMenuOpenChange,
  onMarkRead,
  onMarkUnread,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  renderExtraMenuItems,
}: SidebarChatRowProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { beginSessionDrag, updateSessionDragTarget, endSessionDrag } =
    useSidebarChatDrag();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [flatProjectTooltipOpen, setFlatProjectTooltipOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cancelDeferredEditProjectRef = useRef<(() => void) | null>(null);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "chat", id });
  const inputRef = useRef<HTMLInputElement>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickResetRef = useRef<number | null>(null);
  const sessionWindowSupport = useSessionWindowSupport();
  const isMultiWindowEnabled = sessionWindowSupport.supported;
  const displayTitle = getDisplaySessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const editableTitle = getEditableSessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const [draftTitle, setDraftTitle] = useState(editableTitle);
  const activityTimestamp = showTimestamp
    ? formatSidebarChatTimestamp(activityAt)
    : "";
  const hasFlatProjectColumn = flatProjectName != null;
  const trimmedBranchName = branchName?.trim() ?? "";
  const hasBranchName = trimmedBranchName.length > 0;
  const hasLeadingStatus = isRunning || hasUnread || isPinned;
  // The flat layout's leading column identifies the project, not the chat.
  // Keep quick pinning on the actual chat-icon slot in grouped/Recents rows.
  const showQuickPin =
    showLeadingIcon && !hasFlatProjectColumn && !selectionEnabled;
  const showGutterStatus =
    hasLeadingStatus && !showLeadingIcon && !hasFlatProjectColumn && nested;
  const showInlineLeadingStatus =
    (isRunning || hasUnread || (isPinned && !showQuickPin)) &&
    !showGutterStatus;
  const showLeadingSlot = showLeadingIcon || showInlineLeadingStatus;
  const densityClasses = SIDEBAR_CHAT_ROW_DENSITY_CLASSES[density];
  const rowPaddingClass =
    contentPaddingClassName ??
    (nested
      ? showLeadingIcon
        ? "pl-9"
        : "pl-[38px]"
      : densityClasses.contentPadding);
  const quickPinInsetClass = nested ? "left-9" : "left-3";
  const selectionCount = selectedSessionIds?.size ?? 0;
  const shouldApplyToSelection = selected && selectionCount > 1;
  const showSelectionCheck =
    selectionEnabled && selected && onSelectionChange != null;
  const isOpenInWindow = useSessionWindowStore((s) =>
    isMultiWindowEnabled ? s.isOpenInWindow(id) : false,
  );
  const openWindowLabel = t("actions.openInWindow");
  const openNewWindowLabel = t("actions.openInNewWindow");
  const rowButtonStateClass = selected
    ? SELECTED_CHAT_ROW_CLASS
    : isActive
      ? ACTIVE_CHAT_ROW_CLASS
      : INACTIVE_CHAT_ROW_CLASS;
  const leadingIconSlotClass = cn(
    "flex size-4 shrink-0 items-center justify-center",
    hasBranchName && "mt-0.5 self-start",
  );
  const gutterStatusSlotClass = cn(
    "pointer-events-none absolute left-3 flex size-4 shrink-0 items-center justify-center",
    hasBranchName ? "top-2.5" : "top-1/2 -translate-y-1/2",
  );
  const renderStatusIndicator = (className: string, testId?: string) => {
    if (isRunning) {
      return (
        <span
          className={className}
          role="status"
          aria-label={t("status.chatActive")}
          data-testid={testId}
        >
          <ActiveChatBerdIndicator size={16} />
        </span>
      );
    }

    if (hasUnread) {
      return (
        <span
          className={className}
          role="status"
          aria-label={t("status.unreadMessages")}
          data-testid={testId}
        >
          <SidebarUnreadDot />
        </span>
      );
    }

    if (isPinned) {
      return (
        <span
          className={className}
          role="img"
          aria-label={t("status.pinnedChat")}
          data-testid={testId}
        >
          <IconPin className="size-4" />
        </span>
      );
    }

    return null;
  };
  // Title block shared by the flat and grouped row variants: single-line
  // title, or a two-line title + git branch subtitle when a branch is shown.
  const rowTitleContent = hasBranchName ? (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="truncate leading-snug">{displayTitle}</span>
      <span className="flex min-w-0 items-center gap-1 truncate text-xs leading-snug text-muted-foreground/70">
        <IconGitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{trimmedBranchName}</span>
      </span>
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
  );

  const flatProjectIconColumnClass = cn(
    "flex shrink-0 items-center justify-center",
    densityClasses.flatProjectIconColumn,
  );
  const flatProjectIconSlotClass = cn(
    flatProjectIconColumnClass,
    densityClasses.flatProjectIconInset,
    hasBranchName && "mt-1.5 self-start",
  );
  const flatActivityIndicator = isRunning ? (
    <span
      className={flatProjectIconColumnClass}
      role="status"
      aria-label={t("status.chatActive")}
    >
      <ActiveChatBerdIndicator size={16} />
    </span>
  ) : hasUnread ? (
    <span
      className={flatProjectIconColumnClass}
      role="status"
      aria-label={t("status.unreadMessages")}
    >
      <SidebarUnreadDot />
    </span>
  ) : isPinned ? (
    <span
      className={flatProjectIconColumnClass}
      role="img"
      aria-label={t("status.pinnedChat")}
    >
      <IconPin className="size-4" />
    </span>
  ) : null;
  const hasClickableFlatProject =
    hasFlatProjectColumn && currentProjectId != null && onEditProject != null;
  const flatProjectGlyph = currentProjectId ? (
    <ProjectIcon
      icon={flatProjectIcon}
      color={flatProjectColor}
      projectId={currentProjectId}
      className="size-[18px]"
      imageClassName="size-[18px] rounded-[4px]"
    />
  ) : (
    <SidebarChatMenuIcon
      className="size-4"
      testId="sidebar-flat-chat-project-icon"
    />
  );

  const toggleQuickPin = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isPinningToHome) return;
    if (isPinnedToHome) {
      unpinFromHome();
      return;
    }
    void pinToHome();
  };

  const handleRowClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isMultiSelectModifier(event)) {
      onSelectionChange?.(id, !selected);
      return;
    }
    if (selectionEnabled) {
      onSelectionClear?.();
    }
    if (isOpenInWindow) {
      focusExistingWindow();
      return;
    }
    onSelect?.(id);
  };

  const handleRowDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startRename();
  };

  const handleEditFlatProject = (event: MouseEvent<HTMLButtonElement>) => {
    if (!currentProjectId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    setFlatProjectTooltipOpen(false);

    const projectId = currentProjectId;
    cancelDeferredEditProjectRef.current?.();
    cancelDeferredEditProjectRef.current = scheduleAfterNextPaint(() => {
      cancelDeferredEditProjectRef.current = null;
      onEditProject?.(projectId);
    });
  };

  useEffect(() => {
    setDraftTitle(editableTitle);
  }, [editableTitle]);

  useEffect(() => {
    return () => {
      cancelDeferredEditProjectRef.current?.();
      cancelDeferredEditProjectRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const closeMenus = () => {
    setMenuOpen(false);
    setContextMenuOpen(false);
    onMenuOpenChange?.(false);
  };

  const startRename = () => {
    setDraftTitle(editableTitle);
    closeMenus();
    setEditing(true);
  };

  const cancelRename = () => {
    setDraftTitle(editableTitle);
    setEditing(false);
  };

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    setEditing(false);
    if (
      !nextTitle ||
      isSessionTitleUnchanged(
        nextTitle,
        title,
        t("common:session.defaultTitle"),
      )
    ) {
      return;
    }
    onRename?.(id, nextTitle);
  };

  const focusExistingWindow = () => {
    void focusSessionWindow(id).catch((error) => {
      console.error("Failed to focus session window:", error);
      toast.error(t("actions.focusWindowFailed"));
    });
  };

  const handleOpenInWindow = () => {
    closeMenus();
    void (async () => {
      await openSessionWindow(id, { handoff: isRunning });
    })().catch((error) => {
      console.error("Failed to open session window:", error);
      toast.error(t("actions.openWindowFailed"));
    });
  };

  const clearPointerDragListeners = () => {
    pointerDragCleanupRef.current?.();
    pointerDragCleanupRef.current = null;
  };

  const finishPointerDrag = () => {
    clearPointerDragListeners();
    pointerDragRef.current = null;
    setDragging(false);
    endSessionDrag();
    if (suppressNextClickRef.current) {
      schedulePointerDragClickSuppressionReset(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPrimaryPointerButton(event) || editing) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("[data-sidebar-drag-ignore]")
    ) {
      return;
    }

    clearPointerDragListeners();
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;

      const isDragging =
        drag.dragging ||
        hasExceededPointerDragThreshold({
          startX: drag.startX,
          startY: drag.startY,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
        });

      if (!isDragging) return;

      moveEvent.preventDefault();
      suppressNextClickRef.current = true;
      if (!drag.dragging) {
        pointerDragRef.current = { ...drag, dragging: true };
        closeMenus();
        setDragging(true);
        beginSessionDrag(id, currentProjectId);
      }
      updateSessionDragTarget(moveEvent.clientX, moveEvent.clientY);
    };

    const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || upEvent.pointerId !== drag.pointerId) return;

      if (drag.dragging) {
        upEvent.preventDefault();
        const target = updateSessionDragTarget(
          upEvent.clientX,
          upEvent.clientY,
        );
        target?.onDrop(id);
      }
      finishPointerDrag();
    };

    const handlePointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || cancelEvent.pointerId !== drag.pointerId) return;
      finishPointerDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    pointerDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  };

  useEffect(() => {
    return () => {
      pointerDragCleanupRef.current?.();
      clearPointerDragClickSuppression(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    };
  }, []);

  const renderMenuItems = ({
    Item,
    Label,
    Separator,
  }: RenderMenuItemsOptions) => (
    <>
      {shouldApplyToSelection && (
        <>
          <Label
            className={cn(
              "text-sm font-medium text-muted-foreground",
              menuLabelClassName,
            )}
            style={menuLabelStyle}
          >
            {t("bulk.selectedContext", {
              count: selectionCount,
              displayCount: selectionCount,
            })}
          </Label>
          <Separator className="mx-2 bg-popover-inverse-muted-foreground/35" />
        </>
      )}
      {!shouldApplyToSelection && (
        <>
          {isMultiWindowEnabled ? (
            <Item
              className={menuItemClassName}
              onClick={
                isOpenInWindow ? focusExistingWindow : handleOpenInWindow
              }
              style={menuItemStyle}
            >
              <ExternalLink className="size-3.5" />
              {isOpenInWindow ? openWindowLabel : openNewWindowLabel}
            </Item>
          ) : null}
          <Item
            className={menuItemClassName}
            onClick={startRename}
            style={menuItemStyle}
          >
            <Pencil className="size-3.5" />
            {t("common:actions.rename")}
          </Item>
          {onFork ? (
            <Item
              className={menuItemClassName}
              onClick={() => {
                closeMenus();
                onFork(id);
              }}
              style={menuItemStyle}
            >
              <CopyPlus className="size-3.5" />
              {t("common:actions.duplicate")}
            </Item>
          ) : null}
          {renderExtraMenuItems?.({
            Item,
            Label,
            Separator,
            itemClassName: menuItemClassName,
            itemStyle: menuItemStyle,
          })}
        </>
      )}
      <Item
        className={menuItemClassName}
        onClick={() => {
          if (shouldApplyToSelection) {
            onPinSelectedToHome?.();
            return;
          }
          if (isPinnedToHome) {
            unpinFromHome();
            return;
          }
          void pinToHome();
        }}
        disabled={
          shouldApplyToSelection ? isPinningSelectedToHome : isPinningToHome
        }
        style={menuItemStyle}
      >
        <IconPin className="size-3.5" />
        {shouldApplyToSelection
          ? isPinningSelectedToHome
            ? t("common:actions.pinningChat")
            : t("common:actions.pinChat")
          : isPinnedToHome
            ? t("common:actions.unpinChat")
            : isPinningToHome
              ? t("common:actions.pinningChat")
              : t("common:actions.pinChat")}
      </Item>
      {hasUnread ? (
        <Item
          className={menuItemClassName}
          onClick={() => {
            if (shouldApplyToSelection) {
              onMarkSelectedRead?.();
              return;
            }
            onMarkRead?.(id);
          }}
          disabled={shouldApplyToSelection && selectionActionsDisabled}
          style={menuItemStyle}
        >
          <MailOpen className="size-3.5" />
          {t("actions.markRead")}
        </Item>
      ) : (
        <Item
          className={menuItemClassName}
          onClick={() => {
            if (shouldApplyToSelection) {
              onMarkSelectedUnread?.();
              return;
            }
            onMarkUnread?.(id);
          }}
          disabled={shouldApplyToSelection && selectionActionsDisabled}
          style={menuItemStyle}
        >
          <Mail className="size-3.5" />
          {t("actions.markUnread")}
        </Item>
      )}
      <Item
        className={menuItemClassName}
        onClick={() => {
          if (shouldApplyToSelection) {
            onArchiveSelected?.();
            return;
          }
          onArchive?.(id);
        }}
        disabled={shouldApplyToSelection && selectionActionsDisabled}
        style={menuItemStyle}
      >
        <Archive className="size-3.5" />
        {t("common:actions.archive")}
      </Item>
    </>
  );

  if (editing) {
    return (
      <div
        className={cn("flex items-center group rounded-sm pr-0.5", className)}
      >
        <Input
          ref={inputRef}
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          className={cn(
            "flex-1 min-w-0 pr-3 text-sm font-normal",
            rowPaddingClass,
          )}
          style={{ height: 32 }}
        />
      </div>
    );
  }

  return (
    <ContextMenu
      onOpenChange={(open) => {
        setContextMenuOpen(open);
        onMenuOpenChange?.(open);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          data-session-id={id}
          data-sidebar-chat-row
          data-sidebar-chat-draggable
          onPointerDown={handlePointerDown}
          onClickCapture={(event) => {
            if (!suppressNextClickRef.current) return;
            clearPointerDragClickSuppression(
              suppressNextClickRef,
              suppressNextClickResetRef,
            );
            event.preventDefault();
            event.stopPropagation();
          }}
          className={cn(
            "relative flex items-center group/chat-row rounded-sm hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
            SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
            (isActive || menuOpen || contextMenuOpen) &&
              (!selectionEnabled || selected) &&
              "bg-sidebar-accent",
            selected && SELECTED_CHAT_ROW_CLASS,
            dragging && "bg-sidebar-accent opacity-40",
            hasFlatProjectColumn && densityClasses.flatProjectGap,
            className,
          )}
          data-sidebar-chat-density={density}
        >
          {showGutterStatus
            ? renderStatusIndicator(gutterStatusSlotClass, leadingIconTestId)
            : null}
          {hasFlatProjectColumn ? (
            <>
              {hasClickableFlatProject ? (
                <Tooltip
                  open={flatProjectTooltipOpen}
                  onOpenChange={setFlatProjectTooltipOpen}
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        flatProjectIconSlotClass,
                      )}
                      aria-label={t("actions.editProject", {
                        name: flatProjectName,
                      })}
                      data-sidebar-flat-project-icon
                      data-sidebar-drag-ignore
                      onClick={handleEditFlatProject}
                    >
                      {flatActivityIndicator ?? flatProjectGlyph}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {flatProjectName}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "rounded-sm text-muted-foreground/70",
                        flatProjectIconSlotClass,
                      )}
                      role="img"
                      aria-label={flatProjectName}
                      data-sidebar-flat-project-icon
                    >
                      {flatActivityIndicator ?? flatProjectGlyph}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {flatProjectName}
                  </TooltipContent>
                </Tooltip>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRowClick}
                onDoubleClick={handleRowDoubleClick}
                title={
                  isOpenInWindow ? openWindowLabel : t("actions.renameHint")
                }
                aria-label={displayTitle}
                className={cn(
                  "min-w-0 flex-1 justify-start rounded-sm pl-0",
                  activityTimestamp
                    ? densityClasses.timestampReserve
                    : densityClasses.menuReserve,
                  "gap-0",
                  hasBranchName
                    ? "h-auto py-1.5"
                    : cn(
                        SIDEBAR_ROW_HEIGHT_CLASS,
                        SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
                      ),
                  SIDEBAR_NAV_TEXT_CLASS,
                  rowButtonStateClass,
                )}
                aria-pressed={selectionEnabled ? selected : undefined}
              >
                {rowTitleContent}
                {isMultiWindowEnabled && isOpenInWindow ? (
                  <span
                    className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground/60"
                    role="img"
                    aria-label={openWindowLabel}
                    title={openWindowLabel}
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </span>
                ) : null}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRowClick}
              onDoubleClick={handleRowDoubleClick}
              title={isOpenInWindow ? openWindowLabel : t("actions.renameHint")}
              aria-label={displayTitle}
              className={cn(
                "flex-1 min-w-0 justify-start rounded-sm",
                activityTimestamp
                  ? densityClasses.timestampReserve
                  : densityClasses.menuReserve,
                hasBranchName
                  ? "h-auto py-1.5"
                  : cn(
                      SIDEBAR_ROW_HEIGHT_CLASS,
                      SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
                    ),
                showLeadingSlot && SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
                SIDEBAR_NAV_TEXT_CLASS,
                rowPaddingClass,
                rowButtonStateClass,
              )}
              aria-pressed={selectionEnabled ? selected : undefined}
            >
              {showInlineLeadingStatus ? (
                renderStatusIndicator(leadingIconSlotClass, leadingIconTestId)
              ) : showLeadingIcon ? (
                <span
                  className={cn(
                    leadingIconSlotClass,
                    "transition-opacity duration-150",
                    showQuickPin &&
                      "group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                    isPinnedToHome && "opacity-0",
                  )}
                  aria-hidden="true"
                  data-testid={leadingIconTestId}
                >
                  {leadingIcon ?? <SidebarChatMenuIcon />}
                </span>
              ) : null}
              {rowTitleContent}
              {isMultiWindowEnabled && isOpenInWindow ? (
                <span
                  className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground/60"
                  role="img"
                  aria-label={openWindowLabel}
                  title={openWindowLabel}
                >
                  <ExternalLink className="size-3" aria-hidden="true" />
                </span>
              ) : null}
            </Button>
          )}

          {showQuickPin ? (
            <Button
              type="button"
              variant="ghost"
              flush
              size="icon-xs"
              data-sidebar-drag-ignore
              aria-label={
                isPinnedToHome
                  ? t("common:actions.unpinChat")
                  : t("common:actions.pinChat")
              }
              title={
                isPinnedToHome
                  ? t("common:actions.unpinChat")
                  : t("common:actions.pinChat")
              }
              disabled={isPinningToHome}
              tabIndex={-1}
              onClick={toggleQuickPin}
              className={cn(
                "absolute size-4 rounded-sm text-muted-foreground opacity-0 transition-[color,opacity] duration-150 hover:text-sidebar-foreground focus-visible:opacity-100",
                hasBranchName ? "top-2" : "top-1/2 -translate-y-1/2",
                quickPinInsetClass,
                "group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100",
                isPinnedToHome &&
                  "text-sidebar-foreground opacity-100 hover:text-sidebar-foreground",
              )}
            >
              <IconPin className="size-4" />
            </Button>
          ) : null}

          {activityTimestamp ? (
            <span
              data-sidebar-chat-timestamp
              className={cn(
                "pointer-events-none absolute text-xs tabular-nums text-muted-foreground/70 transition-opacity duration-75",
                hasBranchName ? "top-2" : "top-1/2 -translate-y-1/2",
                densityClasses.menuInset,
                selectionEnabled || menuOpen || contextMenuOpen || dragging
                  ? "opacity-0"
                  : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
              )}
              aria-hidden="true"
            >
              {activityTimestamp}
            </span>
          ) : null}

          {showSelectionCheck ? (
            <span
              className={cn(
                "pointer-events-none absolute flex size-5 items-center justify-center rounded-sm transition-opacity duration-75",
                densityClasses.menuInset,
                dragging || menuOpen || contextMenuOpen
                  ? "opacity-0"
                  : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
              )}
              aria-hidden="true"
            >
              <span className="flex size-3.5 items-center justify-center rounded-full border border-sidebar-foreground bg-sidebar-foreground text-sidebar transition-colors">
                <Check className="size-2.5" strokeWidth={3} />
              </span>
            </span>
          ) : null}

          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              onMenuOpenChange?.(open);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("menu.optionsFor", { label: displayTitle })}
                data-sidebar-drag-ignore
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute size-5 rounded-sm transition-[color,opacity] duration-75 hover:text-sidebar-foreground",
                  densityClasses.menuInset,
                  dragging
                    ? "invisible pointer-events-none opacity-0"
                    : menuOpen
                      ? "visible text-sidebar-foreground opacity-100"
                      : "invisible text-muted-foreground opacity-0 group-hover/chat-row:visible group-hover/chat-row:opacity-100 group-focus-within/chat-row:visible group-focus-within/chat-row:opacity-100",
                )}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              variant="inverse"
              align="start"
              alignOffset={-4}
              sideOffset={4}
              className={menuContentClassName}
            >
              {renderMenuItems({
                Item: DropdownMenuItem as MenuItemComponent,
                Label: DropdownMenuLabel as MenuLabelComponent,
                Separator: DropdownMenuSeparator as MenuSeparatorComponent,
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent variant="inverse" className={menuContentClassName}>
        {renderMenuItems({
          Item: ContextMenuItem as MenuItemComponent,
          Label: ContextMenuLabel as MenuLabelComponent,
          Separator: ContextMenuSeparator as MenuSeparatorComponent,
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
