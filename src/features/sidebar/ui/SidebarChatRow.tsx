import { useEffect, useRef, useState } from "react";
import {
  Archive,
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
import { isMultiSelectModifier } from "@/features/sessions/lib/sessionSelection";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_CHAT_ROW_PADDING_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
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
import { ActiveChatGooseIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SidebarUnreadDot } from "./SidebarUnreadDot";
import { useSidebarChatDrag } from "./SidebarChatDragContext";

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
  isActive: boolean;
  isRunning?: boolean;
  hasUnread?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectedSessionIds?: Set<string>;
  className?: string;
  nested?: boolean;
  /** Project the chat currently lives in, or null when it sits in Recents. */
  currentProjectId?: string | null;
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
  isActive,
  isRunning = false,
  hasUnread = false,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectedSessionIds,
  className,
  nested = false,
  currentProjectId = null,
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
  const { beginSessionDrag, endSessionDrag } = useSidebarChatDrag();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "chat", id });
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = getDisplaySessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const editableTitle = getEditableSessionTitle(
    title,
    t("common:session.defaultTitle"),
  );
  const [draftTitle, setDraftTitle] = useState(editableTitle);
  const rowPaddingClass = nested ? "pl-9" : SIDEBAR_CHAT_ROW_PADDING_CLASS;
  const selectionCount = selectedSessionIds?.size ?? 0;
  const shouldApplyToSelection = selected && selectionCount > 1;
  const rowButtonStateClass = selected
    ? SELECTED_CHAT_ROW_CLASS
    : isActive
      ? ACTIVE_CHAT_ROW_CLASS
      : INACTIVE_CHAT_ROW_CLASS;

  useEffect(() => {
    setDraftTitle(editableTitle);
  }, [editableTitle]);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper handles drag and context menu, interactive content is the inner Button
    <div
      data-session-id={id}
      data-sidebar-chat-row
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-session-id", id);
        e.dataTransfer.effectAllowed = "move";
        setMenuOpen(false);
        setDragging(true);
        beginSessionDrag(id, currentProjectId);
      }}
      onDragEnd={() => {
        setDragging(false);
        endSessionDrag();
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
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(event) => {
          if (isMultiSelectModifier(event)) {
            onSelectionChange?.(id, !selected);
            return;
          }
          if (selectionEnabled) {
            onSelectionClear?.();
          }
          onSelect?.(id);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          startRename();
        }}
        title={t("actions.renameHint")}
        className={cn(
          "flex-1 min-w-0 justify-start gap-2 rounded-sm pr-8 py-2",
          SIDEBAR_NAV_TEXT_CLASS,
          rowPaddingClass,
          rowButtonStateClass,
        )}
        aria-pressed={selectionEnabled ? selected : undefined}
      >
        {isRunning ? (
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
        ) : (
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            <SidebarChatMenuIcon />
          </span>
        )}
        <span className="flex-1 min-w-0 truncate text-left">
          {displayTitle}
        </span>
      </Button>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("menu.optionsFor", { label: displayTitle })}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute right-1 size-5 rounded-sm transition-colors hover:text-sidebar-foreground",
              dragging
                ? "invisible opacity-0 pointer-events-none"
                : menuOpen
                  ? "visible opacity-100 text-sidebar-foreground"
                  : "invisible group-hover/chat-row:visible opacity-0 group-hover/chat-row:opacity-100 text-sidebar-foreground/40",
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
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                {t("bulk.selectedContext", {
                  count: selectionCount,
                  displayCount: selectionCount,
                })}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          {!shouldApplyToSelection && (
            <DropdownMenuItem onClick={startRename}>
              <Pencil className="size-3.5" />
              {t("common:actions.rename")}
            </DropdownMenuItem>
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
            <PinIcon className="size-3.5" />
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
