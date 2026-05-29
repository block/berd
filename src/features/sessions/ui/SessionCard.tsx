import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  Copy,
  Download,
  MoreHorizontal,
  Package,
  Pencil,
  PinIcon,
} from "lucide-react";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { isMultiSelectModifier } from "@/features/sessions/lib/sessionSelection";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";

interface SessionCardProps {
  id: string;
  title: string;
  updatedAt: string;
  personaName?: string;
  projectName?: string;
  projectColor?: string;
  workingDir?: string;
  archivedAt?: string;
  snippet?: string;
  matchCount?: number;
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectionCount?: number;
  onSelect?: (id: string) => void;
  onSelectionClear?: () => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onUnarchive?: (id: string) => void;
  onExport?: (id: string) => void;
  onExportSelected?: () => void;
  onDuplicate?: (id: string) => void;
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
}

export function SessionCard({
  id,
  title,
  updatedAt,
  personaName,
  projectName,
  projectColor,
  workingDir,
  archivedAt,
  snippet,
  matchCount,
  selected = false,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  selectionCount = 0,
  onSelect,
  onSelectionClear,
  onSelectionChange,
  onRename,
  onArchive,
  onArchiveSelected,
  onUnarchive,
  onExport,
  onExportSelected,
  onDuplicate,
  onPinSelectedToHome,
  isPinningSelectedToHome = false,
}: SessionCardProps) {
  const { t } = useTranslation(["sessions", "common"]);
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const [menuOpen, setMenuOpen] = useExclusiveMenu();
  const [editing, setEditing] = useState(false);
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
  const shouldApplyToSelection = selected && selectionCount > 1;

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

  const cancelRename = () => {
    setDraftTitle(editableTitle);
    setEditing(false);
  };

  const relativeTime = formatRelativeTimeToNow(updatedAt);
  const hasSubtitle = Boolean(projectName || relativeTime || personaName);

  if (editing) {
    // Render only the input while editing. Mirrors the sidebar's pattern so
    // the click-overlay button and the meatball trigger aren't mounted to
    // compete for focus with Radix's menu-close focus restoration.
    return (
      <div
        data-session-card
        className={cn(
          "group relative flex min-h-20 flex-col justify-center rounded-card-chat bg-card p-3 text-left",
          selected && "ring-1 ring-inset ring-foreground",
          archivedAt && "opacity-60",
        )}
      >
        <Input
          ref={inputRef}
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
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
          className="text-sm"
        />
      </div>
    );
  }

  return (
    <div
      data-session-card
      className={cn(
        "group relative flex min-h-20 flex-col justify-between gap-1 rounded-card-chat bg-card p-3 text-left transition-shadow",
        "hover:shadow-card",
        selected && "ring-1 ring-inset ring-foreground",
        archivedAt && "opacity-60",
      )}
    >
      {/* Click-to-open overlay */}
      <button
        type="button"
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
        className="absolute inset-0 z-0 rounded-card-chat"
        aria-label={t("card.open", { title: displayTitle })}
        aria-pressed={selectionEnabled ? selected : undefined}
      />

      {/* Title */}
      <p className="relative z-0 line-clamp-1 break-words pr-6 text-sm text-foreground">
        {displayTitle}
      </p>

      {hasSubtitle && (
        <div className="relative z-0 flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-foreground/40">
          {projectName && (
            <span className="inline-flex shrink-0 items-center justify-center">
              {projectColor ? (
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: projectColor }}
                  aria-hidden="true"
                />
              ) : (
                <Package className="size-3" aria-hidden="true" />
              )}
            </span>
          )}
          {projectName && <span className="truncate">{projectName}</span>}
          {projectName && relativeTime && <span aria-hidden="true">•</span>}
          {relativeTime && (
            <span className="truncate whitespace-nowrap">{relativeTime}</span>
          )}
          {personaName && (
            <>
              <span aria-hidden="true">•</span>
              <span className="truncate">{personaName}</span>
            </>
          )}
        </div>
      )}

      {workingDir && !hasSubtitle && (
        <div className="relative z-0 truncate text-[10px] leading-none text-foreground/40">
          {workingDir}
        </div>
      )}

      {(snippet || matchCount) && (
        <div className="relative z-10 mt-1 space-y-1 text-xs">
          {snippet && (
            <p className="line-clamp-3 text-muted-foreground">{snippet}</p>
          )}
          {typeof matchCount === "number" && (
            <p className="font-medium text-foreground/80">
              {t("search.messageMatches", {
                count: matchCount,
                displayCount: matchCount,
              })}
            </p>
          )}
        </div>
      )}

      {/* Actions menu */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("card.optionsFor", { title: displayTitle })}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute right-2 top-2 z-10 size-5 rounded-full transition-colors hover:text-foreground",
              menuOpen
                ? "visible opacity-100 text-foreground"
                : "invisible group-hover:visible opacity-0 group-hover:opacity-100 text-foreground/40",
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
                {t("history.selectedContext", {
                  count: selectionCount,
                  displayCount: selectionCount,
                })}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false);
              onSelectionChange?.(id, !selected);
            }}
          >
            <CheckSquare className="size-3.5" />
            {selected ? t("card.deselect") : t("card.select")}
          </DropdownMenuItem>
          {archivedAt ? (
            <>
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onExport?.(id);
                }}
              >
                <Download className="size-3.5" />
                {t("common:actions.export")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onUnarchive?.(id);
                }}
              >
                <ArchiveRestore className="size-3.5" />
                {t("common:actions.restore")}
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {!shouldApplyToSelection && (
                <DropdownMenuItem onClick={startRename}>
                  <Pencil className="size-3.5" />
                  {t("common:actions.rename")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
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
                  shouldApplyToSelection
                    ? isPinningSelectedToHome
                    : isPinningToHome
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
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  if (shouldApplyToSelection) {
                    onExportSelected?.();
                    return;
                  }
                  onExport?.(id);
                }}
                disabled={shouldApplyToSelection && selectionActionsDisabled}
              >
                <Download className="size-3.5" />
                {t("common:actions.export")}
              </DropdownMenuItem>
              {!shouldApplyToSelection && (
                <DropdownMenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate?.(id);
                  }}
                >
                  <Copy className="size-3.5" />
                  {t("common:actions.duplicate")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
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
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
