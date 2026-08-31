import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Globe2, MoreHorizontal } from "lucide-react";
import { IconCheck, IconGitBranch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import {
  focusSessionWindow,
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowSupport } from "@/features/chat/hooks/useSessionWindowSupport";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { exportSessionAction } from "@/features/sessions/lib/exportSessionAction";
import {
  isMultiSelectModifier,
  isRangeSelectModifier,
} from "@/features/sessions/lib/sessionSelection";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import {
  SessionActionsContextMenuContent,
  SessionActionsMenuContent,
} from "@/features/sessions/ui/SessionActionsMenuItems";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import {
  clearPointerDragClickSuppression,
  hasExceededPointerDragThreshold,
  isPrimaryPointerButton,
  schedulePointerDragClickSuppressionReset,
} from "@/features/sidebar/lib/pointerDrag";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import {
  SIDEBAR_CHAT_ROW_DENSITY_CLASSES,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
  type SidebarChatRowDensity,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatMenuIcon } from "./SidebarChatMenuIcon";
import { DropdownMenu, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger } from "@/shared/ui/context-menu";
import { Input } from "@/shared/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  RESPONDING_SHIMMER_PROPS,
  Shimmer,
} from "@/shared/ui/ai-elements/shimmer";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarUnreadDot } from "./SidebarUnreadDot";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { toast } from "sonner";

const INACTIVE_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const ACTIVE_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
const SELECTED_CHAT_ROW_CLASS = cn(
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);
/**
 * Merge contiguous selected rows into one visual block: a selected row drops
 * its top radius when the neighboring row is also selected.
 *
 * Structural contract: this works via CSS sibling selectors, so sections must
 * render chat rows as direct DOM siblings. A section that wraps each row in an
 * extra element (e.g. the pinned section's reorder wrapper) must mirror
 * `data-selected` onto that wrapper; the second selector group below matches
 * selected wrappers. Only the row's own button (`data-sidebar-chat-row-button`)
 * changes shape — auxiliary buttons like the menu trigger keep their radius.
 */
const SELECTED_CHAT_ROW_MERGE_CLASS = cn(
  // Rows as direct siblings (project/recents/flat sections).
  "[[data-selected]+&]:rounded-t-none [[data-selected]+&>[data-sidebar-chat-row-button]]:rounded-t-none",
  "has-[+[data-selected]]:rounded-b-none [&:has(+[data-selected])>[data-sidebar-chat-row-button]]:rounded-b-none",
  // Rows inside selected wrappers that are direct siblings (pinned section).
  "[[data-selected]+[data-selected]>&]:rounded-t-none [[data-selected]+[data-selected]>&>[data-sidebar-chat-row-button]]:rounded-t-none",
  "[[data-selected]:has(+[data-selected])>&]:rounded-b-none [[data-selected]:has(+[data-selected])>&>[data-sidebar-chat-row-button]]:rounded-b-none",
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

interface SidebarChatRowProps {
  id: string;
  title: string;
  /** Current Git branch for this chat; only passed when the sidebar branch setting is enabled. */
  branchName?: string;
  /** SSH host the chat's backend runs on; shows a remote indicator when set. */
  remoteHost?: string;
  /** Latest visible chat activity. Rendered as a compact relative timestamp on the row's right edge; hidden on hover when the row menu takes its place. */
  activityAt?: string | null;
  showTimestamp?: boolean;
  isActive: boolean;
  isRunning?: boolean;
  hasUnread?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectedSessionIds?: Set<string>;
  className?: string;
  contentPaddingClassName?: string;
  nested?: boolean;
  /** Leading pin-control policy for this list surface. */
  quickPinMode?: "always" | "hover-only" | "pinned-only" | "never";
  /** Rename guidance is omitted on surfaces where rows move under the pointer. */
  showRenameTooltip?: boolean;
  pointerDragEnabled?: boolean;
  density?: SidebarChatRowDensity;
  showLeadingIcon?: boolean;
  leadingIconTestId?: string;
  leadingIcon?: ReactNode;
  /** Semantic row geometry for surfaces with a compact 8px leading rail. */
  geometry?: "default" | "refreshed-primary" | "project-secondary";
  titleTone?: "default" | "muted";
  flatProjectName?: string;
  flatProjectIcon?: string | null;
  flatProjectColor?: string | null;
  /** Project the chat currently lives in, or null when it sits in Recents. */
  currentProjectId?: string | null;
  /** Project chat group the chat currently lives in, when grouped. */
  currentProjectGroupId?: string | null;
  onEditProject?: (projectId: string) => void;
  onSelect?: (id: string) => void;
  onSelectionClear?: () => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  onRangeSelect?: (sessionId: string) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onFork?: (id: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  onUnpinSelectedFromHome?: () => void;
  isSelectionPinnedToHome?: boolean;
  onOpenSelectedInWindows?: () => void;
  isPinningSelectedToHome?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onMarkRead?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
}

export function SidebarChatRow({
  id,
  title,
  branchName,
  remoteHost,
  activityAt,
  showTimestamp = true,
  isActive,
  isRunning = false,
  hasUnread = false,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectedSessionIds,
  className,
  contentPaddingClassName,
  nested = false,
  quickPinMode = "always",
  showRenameTooltip = true,
  pointerDragEnabled = true,
  density = "default",
  showLeadingIcon = true,
  leadingIconTestId,
  leadingIcon,
  geometry = "default",
  titleTone = "default",
  flatProjectName,
  flatProjectIcon,
  flatProjectColor,
  currentProjectId = null,
  currentProjectGroupId = null,
  onEditProject,
  onSelect,
  onSelectionClear,
  onSelectionChange,
  onRangeSelect,
  onRename,
  onFork,
  onArchive,
  onArchiveSelected,
  onPinSelectedToHome,
  onUnpinSelectedFromHome,
  isSelectionPinnedToHome = false,
  onOpenSelectedInWindows,
  isPinningSelectedToHome = false,
  onMenuOpenChange,
  onMarkRead,
  onMarkUnread,
  onMarkSelectedRead,
  onMarkSelectedUnread,
}: SidebarChatRowProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const remoteHostConnected =
    useRemoteHostStore((store) =>
      remoteHost ? store.statusByHost[remoteHost]?.state : undefined,
    ) === "ready";
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const animateRunningState =
    isRunning && workingIndicatorAnimationPreference.enabled;
  const {
    draggingSession,
    beginSessionDrag,
    updateSessionDragTarget,
    endSessionDrag,
  } = useSidebarChatDrag();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPreviewPosition, setDragPreviewPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
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
  // Running and ready/unread states share the trailing timestamp slot.
  // Pin presentation is surface-specific: some lists expose it on hover,
  // while compact Chat lists show only an already-pinned chat as an unpin
  // control. Both occupy the same leading slot when it exists.
  const showQuickPin =
    !selectionEnabled &&
    (quickPinMode === "always" ||
      quickPinMode === "hover-only" ||
      (quickPinMode === "pinned-only" && isPinnedToHome));
  const needsLeadingSlot =
    nested ||
    showLeadingIcon ||
    hasFlatProjectColumn ||
    (showQuickPin && isPinnedToHome);
  const showAbsoluteLeadingSlot = !hasFlatProjectColumn && needsLeadingSlot;
  const densityClasses = SIDEBAR_CHAT_ROW_DENSITY_CLASSES[density];
  const rowPaddingClass =
    geometry === "project-secondary"
      ? nested
        ? "pl-9"
        : needsLeadingSlot
          ? "pl-8"
          : "pl-[10px]"
      : (contentPaddingClassName ??
        (geometry === "refreshed-primary"
          ? needsLeadingSlot
            ? "pl-8"
            : "pl-2"
          : needsLeadingSlot
            ? "pl-[38px]"
            : densityClasses.contentPadding));
  // The chat icon and quick-pin action deliberately share the left gutter:
  // pinning replaces the icon rather than creating a second position.
  const leadingControlInsetClass = geometry === "default" ? "left-3" : "left-2";
  const selectionCount = selectedSessionIds?.size ?? 0;
  const shouldApplyToSelection = selected && selectionCount > 1;
  const showSelectionCheck =
    selectionEnabled && selected && onSelectionChange != null;
  const isOpenInWindow = useSessionWindowStore((s) =>
    isMultiWindowEnabled ? s.isOpenInWindow(id) : false,
  );
  const openWindowLabel = t("actions.openInWindow");
  const rowTooltipLabel = isOpenInWindow
    ? openWindowLabel
    : t("actions.renameHint");
  const showRowTooltip = isOpenInWindow || (showRenameTooltip && !showQuickPin);
  const projectEditLabel = flatProjectName?.trim()
    ? t("actions.editProject", { name: flatProjectName })
    : t("actions.editProjectFallback");
  const rowButtonStateClass = selected
    ? SELECTED_CHAT_ROW_CLASS
    : isActive
      ? ACTIVE_CHAT_ROW_CLASS
      : INACTIVE_CHAT_ROW_CLASS;
  const absoluteLeadingSlotClass = cn(
    "absolute flex size-4 shrink-0 items-center justify-center",
    hasBranchName ? "top-2" : "top-1/2 -translate-y-1/2",
    leadingControlInsetClass,
  );
  // Title block shared by the flat and grouped row variants: single-line
  // title, or a two-line title + git branch subtitle when a branch is shown.
  const titleText = animateRunningState ? (
    <Shimmer
      as="span"
      {...RESPONDING_SHIMMER_PROPS}
      baseColor="var(--color-sidebar-foreground)"
      highlightColor="color-mix(in srgb, var(--color-sidebar-foreground) 25%, var(--color-background))"
      className="!inline leading-[inherit] [--shimmer-ink:var(--color-sidebar-foreground)]"
    >
      {displayTitle}
    </Shimmer>
  ) : (
    displayTitle
  );
  const rowTitleContent = hasBranchName ? (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span
        className={cn(
          "truncate leading-snug",
          titleTone === "muted" && "text-muted-foreground",
        )}
      >
        {titleText}
      </span>
      <span className="flex min-w-0 items-center gap-1 truncate text-xs leading-snug text-muted-foreground/70">
        <IconGitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{trimmedBranchName}</span>
      </span>
    </span>
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-left",
        titleTone === "muted" && "text-muted-foreground",
      )}
    >
      {titleText}
    </span>
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
    if (onRangeSelect && isRangeSelectModifier(event)) {
      event.preventDefault();
      onRangeSelect(id);
      return;
    }
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

  const titleButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-sidebar-chat-row-button
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      aria-label={displayTitle}
      className={cn(
        "min-w-0 flex-1 justify-start rounded-sm",
        hasFlatProjectColumn ? "pl-0 gap-0" : rowPaddingClass,
        isRunning || hasUnread || activityTimestamp
          ? densityClasses.timestampReserve
          : densityClasses.menuReserve,
        hasBranchName
          ? "h-auto py-1.5"
          : cn(SIDEBAR_ROW_HEIGHT_CLASS, SIDEBAR_ROW_VERTICAL_PADDING_CLASS),
        SIDEBAR_NAV_TEXT_CLASS,
        rowButtonStateClass,
      )}
      aria-pressed={selectionEnabled ? selected : undefined}
    >
      {rowTitleContent}
      {remoteHost ? (
        <span
          data-sidebar-chat-remote-host
          data-remote-host-connected={remoteHostConnected ? "true" : "false"}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            remoteHostConnected ? "text-info" : "text-sidebar-foreground/50",
          )}
          role="img"
          aria-label={t(
            remoteHostConnected
              ? "status.remoteHost"
              : "status.remoteHostDisconnected",
            { host: remoteHost },
          )}
          title={t(
            remoteHostConnected
              ? "status.remoteHost"
              : "status.remoteHostDisconnected",
            { host: remoteHost },
          )}
        >
          <Globe2 className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {isMultiWindowEnabled && isOpenInWindow ? (
        <span
          className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground/60"
          role="img"
          aria-label={openWindowLabel}
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </span>
      ) : null}
    </Button>
  );
  const rowButton = showRowTooltip ? (
    <Tooltip delayDuration={TOOLTIP_DELAY.restedHover} disableHoverableContent>
      <TooltipTrigger asChild>{titleButton}</TooltipTrigger>
      <TooltipContent pointerEvents="none">{rowTooltipLabel}</TooltipContent>
    </Tooltip>
  ) : (
    titleButton
  );

  useEffect(() => {
    setDraftTitle(editableTitle);
  }, [editableTitle]);

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

  const handleExport = () => {
    void exportSessionAction({
      sessionId: id,
      title,
      displayTitle,
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
    setDragPreviewPosition(null);
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
      setDragPreviewPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      if (!drag.dragging) {
        pointerDragRef.current = { ...drag, dragging: true };
        closeMenus();
        setDragging(true);
        beginSessionDrag(id, currentProjectId, currentProjectGroupId);
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

  const sessionActionsMenuProps = {
    sessionId: id,
    onClose: closeMenus,
    hasUnread,
    isPinned: isPinnedToHome,
    isPinning: shouldApplyToSelection
      ? isPinningSelectedToHome
      : isPinningToHome,
    isOpenInWindow,
    selectionCount: shouldApplyToSelection ? selectionCount : 0,
    selectionActionsDisabled,
    onMarkRead: shouldApplyToSelection
      ? onMarkSelectedRead
      : () => onMarkRead?.(id),
    onMarkUnread: shouldApplyToSelection
      ? onMarkSelectedUnread
      : () => onMarkUnread?.(id),
    onTogglePin: shouldApplyToSelection
      ? isSelectionPinnedToHome
        ? onUnpinSelectedFromHome
        : onPinSelectedToHome
      : () => {
          if (isPinnedToHome) {
            unpinFromHome();
            return;
          }
          void pinToHome();
        },
    isSelectionPinned: isSelectionPinnedToHome,
    onRename: startRename,
    onOpenInWindow: isMultiWindowEnabled
      ? isOpenInWindow
        ? focusExistingWindow
        : handleOpenInWindow
      : undefined,
    onOpenSelectedInWindows,
    onDuplicate: onFork ? () => onFork(id) : undefined,
    editProjectLabel: projectEditLabel,
    onEditProject:
      currentProjectId && onEditProject && hasFlatProjectColumn
        ? () => onEditProject(currentProjectId)
        : undefined,
    onExport: handleExport,
    onArchive: shouldApplyToSelection
      ? onArchiveSelected
      : () => onArchive?.(id),
  };

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
          data-selected={selected ? "" : undefined}
          onPointerDown={pointerDragEnabled ? handlePointerDown : undefined}
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
            "relative flex items-center group/chat-row rounded-sm hover:bg-[var(--sidebar-row-hover)] focus-within:bg-[var(--sidebar-row-hover)]",
            SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
            (isActive || menuOpen || contextMenuOpen) &&
              (!selectionEnabled || selected) &&
              "bg-[var(--sidebar-row-active)]",
            selected && SELECTED_CHAT_ROW_CLASS,
            selected && SELECTED_CHAT_ROW_MERGE_CLASS,
            draggingSession !== null && "pointer-events-none",
            dragging && "bg-[var(--sidebar-row-active)] opacity-40",
            hasFlatProjectColumn && densityClasses.flatProjectGap,
            className,
          )}
          data-sidebar-chat-density={density}
        >
          {dragging && dragPreviewPosition && typeof document !== "undefined"
            ? createPortal(
                <div
                  aria-hidden="true"
                  data-sidebar-chat-drag-preview
                  className="pointer-events-none fixed z-50 flex max-w-72 items-center gap-2 rounded-sm border border-sidebar-border bg-card-glass px-3 py-2 text-sm text-sidebar-foreground shadow-lg [backdrop-filter:var(--backdrop-panel)] [-webkit-backdrop-filter:var(--backdrop-panel)]"
                  style={{
                    left: dragPreviewPosition.x + 12,
                    top: dragPreviewPosition.y + 12,
                  }}
                >
                  <SidebarChatMenuIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{displayTitle}</span>
                </div>,
                document.body,
              )
            : null}
          {showAbsoluteLeadingSlot ? (
            <SidebarLeadingIcon
              className={absoluteLeadingSlotClass}
              activeLabel={t("status.chatActive")}
              unreadLabel={t("status.unreadMessages")}
              quickPin={
                showQuickPin
                  ? {
                      pinned: isPinnedToHome,
                      disabled: isPinningToHome,
                      persistWhenPinned: quickPinMode !== "hover-only",
                      pinLabel: t("common:actions.pinChat"),
                      unpinLabel: t("common:actions.unpinChat"),
                      onClick: toggleQuickPin,
                    }
                  : undefined
              }
              testId={leadingIconTestId}
            >
              {showLeadingIcon
                ? (leadingIcon ?? <SidebarChatMenuIcon />)
                : null}
            </SidebarLeadingIcon>
          ) : null}
          {hasFlatProjectColumn ? (
            <>
              <SidebarLeadingIcon
                activeLabel={t("status.chatActive")}
                unreadLabel={t("status.unreadMessages")}
                className={cn(
                  "rounded-sm text-muted-foreground/70",
                  flatProjectIconSlotClass,
                )}
                quickPin={
                  showQuickPin
                    ? {
                        pinned: isPinnedToHome,
                        disabled: isPinningToHome,
                        persistWhenPinned: quickPinMode !== "hover-only",
                        pinLabel: t("common:actions.pinChat"),
                        unpinLabel: t("common:actions.unpinChat"),
                        onClick: toggleQuickPin,
                      }
                    : undefined
                }
              >
                <span aria-hidden="true" data-sidebar-flat-project-icon>
                  {flatProjectGlyph}
                </span>
              </SidebarLeadingIcon>
              {rowButton}
            </>
          ) : (
            rowButton
          )}

          {isRunning ? (
            <span
              data-sidebar-chat-status
              role="status"
              aria-label={t("status.chatActive")}
              className={cn(
                "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                densityClasses.menuInset,
                selectionEnabled || menuOpen || contextMenuOpen || dragging
                  ? "opacity-0"
                  : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
              )}
            >
              <ActiveChatPulseDot />
            </span>
          ) : hasUnread ? (
            <span
              data-sidebar-chat-ready-status
              role="status"
              aria-label={t("status.unreadMessages")}
              className={cn(
                "pointer-events-none absolute flex size-5 items-center justify-center transition-opacity duration-75",
                hasBranchName ? "top-1" : "top-1/2 -translate-y-1/2",
                densityClasses.menuInset,
                selectionEnabled || menuOpen || contextMenuOpen || dragging
                  ? "opacity-0"
                  : "opacity-100 group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
              )}
            >
              <SidebarUnreadDot />
            </span>
          ) : activityTimestamp ? (
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
              <IconCheck className="size-4 text-sidebar-foreground" />
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
                flush
                size="icon-xs"
                aria-label={t("menu.optionsFor", { label: displayTitle })}
                data-sidebar-drag-ignore
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute size-5",
                  densityClasses.menuInset,
                  dragging
                    ? "invisible pointer-events-none opacity-0"
                    : menuOpen
                      ? "visible opacity-100"
                      : "invisible opacity-0 group-hover/chat-row:visible group-hover/chat-row:opacity-100 group-focus-within/chat-row:visible group-focus-within/chat-row:opacity-100",
                )}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <SessionActionsMenuContent {...sessionActionsMenuProps} />
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <SessionActionsContextMenuContent {...sessionActionsMenuProps} />
    </ContextMenu>
  );
}
