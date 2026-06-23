import {
  type MouseEvent,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  Archive,
  ExternalLink,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pencil,
  PinIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";
import { SidebarNavChatsIcon } from "@/features/navigation/ui/sidebarNavIcons";
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
import { Input } from "@/shared/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ActiveChatGooseIndicator } from "@/shared/ui/SessionActivityIndicator";
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

interface SidebarChatRowProps {
  id: string;
  title: string;
  /** Snippet of the session's latest real text message; hides when absent. */
  subtitle?: string;
  isActive: boolean;
  isRunning?: boolean;
  hasUnread?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectedSessionIds?: Set<string>;
  className?: string;
  nested?: boolean;
  density?: SidebarChatRowDensity;
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
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkRead?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
}

export function SidebarChatRow({
  id,
  title,
  subtitle,
  isActive,
  isRunning = false,
  hasUnread = false,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectedSessionIds,
  className,
  nested = false,
  density = "default",
  flatProjectName,
  flatProjectIcon,
  flatProjectColor,
  currentProjectId = null,
  onEditProject,
  onSelect,
  onSelectionClear,
  onSelectionChange,
  onRename,
  onArchive,
  onArchiveSelected,
  onPinSelectedToHome,
  isPinningSelectedToHome = false,
  onMarkRead,
  onMarkUnread,
  onMarkSelectedRead,
  onMarkSelectedUnread,
}: SidebarChatRowProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { beginSessionDrag, updateSessionDragTarget, endSessionDrag } =
    useSidebarChatDrag();
  const [menuOpen, setMenuOpen] = useState(false);
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
  // Only render the subtitle line when there's a real snippet — older or
  // tool-only sessions keep the single-line layout they have today.
  const trimmedSubtitle = subtitle?.trim() ?? "";
  const hasFlatProjectColumn = flatProjectName != null;
  const hasSubtitle = trimmedSubtitle.length > 0 && !hasFlatProjectColumn;
  const densityClasses = SIDEBAR_CHAT_ROW_DENSITY_CLASSES[density];
  const rowPaddingClass = nested ? "pl-9" : densityClasses.contentPadding;
  const selectionCount = selectedSessionIds?.size ?? 0;
  const shouldApplyToSelection = selected && selectionCount > 1;
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
    hasSubtitle && "mt-0.5 self-start",
  );
  const flatActivityIndicator = isRunning ? (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      role="status"
      aria-label={t("status.chatActive")}
    >
      <ActiveChatGooseIndicator size={16} />
    </span>
  ) : hasUnread ? (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      role="status"
      aria-label={t("status.unreadMessages")}
    >
      <SidebarUnreadDot />
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
    <SidebarNavChatsIcon className="size-4" />
  );

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

  const startRename = () => {
    setDraftTitle(editableTitle);
    setMenuOpen(false);
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
    setMenuOpen(false);
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
        setMenuOpen(false);
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
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper handles pointer drag and context menu; interactive content is the inner Button
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
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        "relative flex items-center group/chat-row rounded-sm hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
        SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
        (isActive || menuOpen) &&
          (!selectionEnabled || selected) &&
          "bg-sidebar-accent",
        selected && SELECTED_CHAT_ROW_CLASS,
        dragging && "bg-sidebar-accent opacity-40",
        hasFlatProjectColumn && densityClasses.flatProjectGap,
        className,
      )}
      data-sidebar-chat-density={density}
    >
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
                    "flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    densityClasses.flatProjectIconInset,
                    densityClasses.flatProjectIconColumn,
                  )}
                  aria-label={t("actions.editProject", {
                    name: flatProjectName,
                  })}
                  data-sidebar-flat-project-icon
                  data-sidebar-drag-ignore
                  onClick={handleEditFlatProject}
                >
                  {flatProjectGlyph}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{flatProjectName}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-sm text-muted-foreground/70",
                    densityClasses.flatProjectIconInset,
                    densityClasses.flatProjectIconColumn,
                  )}
                  role="img"
                  aria-label={flatProjectName}
                  data-sidebar-flat-project-icon
                >
                  {flatProjectGlyph}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{flatProjectName}</TooltipContent>
            </Tooltip>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRowClick}
            onDoubleClick={handleRowDoubleClick}
            title={isOpenInWindow ? openWindowLabel : t("actions.renameHint")}
            className={cn(
              "min-w-0 flex-1 justify-start rounded-sm pl-0",
              densityClasses.menuReserve,
              flatActivityIndicator ? densityClasses.flatProjectGap : "gap-0",
              SIDEBAR_ROW_HEIGHT_CLASS,
              SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
              SIDEBAR_NAV_TEXT_CLASS,
              rowButtonStateClass,
            )}
            aria-pressed={selectionEnabled ? selected : undefined}
          >
            {flatActivityIndicator}
            <span className="min-w-0 truncate text-left">{displayTitle}</span>
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
          className={cn(
            "flex-1 min-w-0 justify-start rounded-sm",
            densityClasses.menuReserve,
            hasSubtitle
              ? "h-auto py-1.5"
              : cn(
                  SIDEBAR_ROW_HEIGHT_CLASS,
                  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
                ),
            SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
            SIDEBAR_NAV_TEXT_CLASS,
            rowPaddingClass,
            rowButtonStateClass,
          )}
          aria-pressed={selectionEnabled ? selected : undefined}
        >
          {isRunning ? (
            <span
              className={leadingIconSlotClass}
              role="status"
              aria-label={t("status.chatActive")}
            >
              <ActiveChatGooseIndicator size={16} />
            </span>
          ) : hasUnread ? (
            <span
              className={leadingIconSlotClass}
              role="status"
              aria-label={t("status.unreadMessages")}
            >
              <SidebarUnreadDot />
            </span>
          ) : (
            <span className={leadingIconSlotClass} aria-hidden="true">
              <SidebarChatMenuIcon />
            </span>
          )}
          {hasSubtitle ? (
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="truncate leading-snug">{displayTitle}</span>
              <span className="truncate text-xs leading-snug text-muted-foreground">
                {trimmedSubtitle}
              </span>
            </span>
          ) : (
            <span className="flex-1 min-w-0 truncate text-left">
              {displayTitle}
            </span>
          )}
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

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          variant="inverse"
          align="start"
          alignOffset={-4}
          sideOffset={4}
        >
          {shouldApplyToSelection && (
            <>
              <DropdownMenuLabel className="text-sm font-medium text-muted-foreground">
                {t("bulk.selectedContext", {
                  count: selectionCount,
                  displayCount: selectionCount,
                })}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          {!shouldApplyToSelection && (
            <>
              {isMultiWindowEnabled ? (
                <DropdownMenuItem
                  onClick={
                    isOpenInWindow ? focusExistingWindow : handleOpenInWindow
                  }
                >
                  <ExternalLink className="size-3.5" />
                  {isOpenInWindow ? openWindowLabel : openNewWindowLabel}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={startRename}>
                <Pencil className="size-3.5" />
                {t("common:actions.rename")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem
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
          >
            <PinIcon
              className="size-3.5"
              fill={
                !shouldApplyToSelection && isPinnedToHome
                  ? "currentColor"
                  : "none"
              }
            />
            {shouldApplyToSelection
              ? isPinningSelectedToHome
                ? t("common:actions.pinningToHome")
                : t("common:actions.pinToHome")
              : isPinnedToHome
                ? t("common:actions.unpinFromHome")
                : isPinningToHome
                  ? t("common:actions.pinningToHome")
                  : t("common:actions.pinToHome")}
          </DropdownMenuItem>
          {hasUnread ? (
            <DropdownMenuItem
              onClick={() => {
                if (shouldApplyToSelection) {
                  onMarkSelectedRead?.();
                  return;
                }
                onMarkRead?.(id);
              }}
              disabled={shouldApplyToSelection && selectionActionsDisabled}
            >
              <MailOpen className="size-3.5" />
              {t("actions.markRead")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => {
                if (shouldApplyToSelection) {
                  onMarkSelectedUnread?.();
                  return;
                }
                onMarkUnread?.(id);
              }}
              disabled={shouldApplyToSelection && selectionActionsDisabled}
            >
              <Mail className="size-3.5" />
              {t("actions.markUnread")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              if (shouldApplyToSelection) {
                onArchiveSelected?.();
                return;
              }
              onArchive?.(id);
            }}
            disabled={shouldApplyToSelection && selectionActionsDisabled}
          >
            <Archive className="size-3.5" />
            {t("common:actions.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
