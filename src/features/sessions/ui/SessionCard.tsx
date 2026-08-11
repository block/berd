import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Package } from "lucide-react";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import {
  useSessionActionsMenu,
  useSessionRename,
} from "@/features/sessions/hooks/useSessionItemActions";
import { isMultiSelectModifier } from "@/features/sessions/lib/sessionSelection";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { ContextMenu, ContextMenuTrigger } from "@/shared/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { SessionCardActionButton } from "@/shared/ui/session-card-action-button";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";
import {
  SessionActionsContextMenuContent,
  SessionActionsMenuContent,
} from "./SessionActionsMenuItems";

export interface SessionCardProps {
  id: string;
  title: string;
  updatedAt: string;
  personaName?: string;
  projectId?: string;
  projectName?: string;
  projectColor?: string;
  projectIcon?: string;
  workingDir?: string;
  archivedAt?: string;
  snippet?: string;
  snippetLineClamp?: 1 | 2 | 3;
  matchCount?: number;
  /**
   * Presentation: `row` is the full-width automations-style row; `grid` is a
   * compact vertical card for the multi-column browse grid.
   */
  layout?: "row" | "grid";
  selected?: boolean;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  selectionCount?: number;
  onSelect?: (id: string) => void;
  onSelectionClear?: () => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onFork?: (id: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onUnarchive?: (id: string) => void;
  onUnarchiveSelected?: () => void;
  onExport?: (id: string) => void;
  onExportSelected?: () => void;
  onOpenInWindow?: (id: string) => void;
  isOpenInWindow?: boolean;
  onPinSelectedToHome?: () => void;
  onUnpinSelectedFromHome?: () => void;
  isSelectionPinnedToHome?: boolean;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
}

export function SessionCard(props: SessionCardProps) {
  const {
    id,
    title,
    updatedAt,
    personaName,
    projectId,
    projectName,
    projectColor,
    projectIcon,
    workingDir,
    archivedAt,
    snippet,
    snippetLineClamp = 3,
    matchCount,
    layout = "row",
    selected = false,
    selectionEnabled = false,
    onSelect,
    onSelectionClear,
    onSelectionChange,
    onRename,
    onOpenInWindow,
  } = props;
  const { t } = useTranslation(["sessions", "common"]);
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  // Only the dropdown participates in the exclusive-menu latch. The context
  // menu is uncontrolled, and Radix already dismisses one menu when another
  // opens, so the two never render together in practice; joining the latch
  // would mean lifting context-menu open state for no visible gain.
  const [menuOpen, setMenuOpen] = useExclusiveMenu();
  // Read inside Radix's close sequence, so it must not be state: a re-render
  // there would fight the rename input for focus, which is the very thing the
  // guard below exists to avoid.
  const renameInvokedFromContextMenuRef = useRef(false);
  const {
    editing,
    inputRef,
    displayTitle,
    draftTitle,
    setDraftTitle,
    startRename,
    commitRename,
    cancelRename,
  } = useSessionRename({
    id,
    title,
    defaultTitle: t("common:session.defaultTitle"),
    onRename,
  });
  const menuProps = useSessionActionsMenu(props);

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
          "group relative flex min-h-[86px] w-full flex-col justify-center rounded-md bg-card px-6 py-5 text-left",
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-session-card
          className={cn(
            "group relative w-full rounded-md bg-card text-left",
            layout === "row"
              ? "grid min-h-[86px] gap-3 px-6 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
              : "flex h-full min-h-32 flex-col px-5 py-4",
            "transition-[background-color,box-shadow,border-color] duration-200 hover:shadow-card hover:ring-1 hover:ring-inset hover:ring-border/80",
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
            className="absolute inset-0 z-0 rounded-md"
            aria-label={t("card.open", { title: displayTitle })}
            aria-pressed={selectionEnabled ? selected : undefined}
          />

          {/* Left column: title, project meta, message preview */}
          <span
            data-card-content
            className="pointer-events-none relative z-0 min-w-0"
          >
            <span
              className={cn(
                "block text-base font-normal text-foreground",
                layout === "row"
                  ? "truncate pr-6 md:pr-0"
                  : "line-clamp-2 pr-6",
              )}
            >
              {displayTitle}
            </span>

            {hasSubtitle && (
              <span className="mt-2 flex min-w-0 items-center gap-1.5 text-xs leading-normal text-muted-foreground">
                {projectName && (
                  <span className="inline-flex shrink-0 items-center justify-center">
                    {projectId || projectIcon ? (
                      <ProjectIcon
                        icon={projectIcon}
                        color={projectColor}
                        projectId={projectId}
                        className="size-3.5"
                        imageClassName="size-3.5 rounded-[3px] object-contain"
                      />
                    ) : projectColor ? (
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
                {personaName && (
                  <>
                    {projectName && <span aria-hidden="true">•</span>}
                    <span className="truncate">{personaName}</span>
                  </>
                )}
                {relativeTime && (
                  <>
                    {(projectName || personaName) && (
                      <span
                        className={cn(layout === "row" && "md:hidden")}
                        aria-hidden="true"
                      >
                        •
                      </span>
                    )}
                    <span
                      className={cn(
                        "truncate whitespace-nowrap",
                        layout === "row" && "md:hidden",
                      )}
                    >
                      {relativeTime}
                    </span>
                  </>
                )}
              </span>
            )}

            {workingDir && !hasSubtitle && (
              <span className="mt-2 block truncate text-xs leading-normal text-muted-foreground">
                {workingDir}
              </span>
            )}

            {(snippet || typeof matchCount === "number") && (
              <span className="mt-2 block space-y-1">
                {snippet && (
                  <span
                    className={cn(
                      snippetLineClamp === 1
                        ? "line-clamp-1"
                        : snippetLineClamp === 2
                          ? "line-clamp-2"
                          : "line-clamp-3",
                      "text-sm text-muted-foreground",
                    )}
                  >
                    {snippet}
                  </span>
                )}
                {typeof matchCount === "number" && (
                  <span className="block text-xs font-medium text-foreground/80">
                    {t("search.messageMatches", {
                      count: matchCount,
                      displayCount: matchCount,
                    })}
                  </span>
                )}
              </span>
            )}
          </span>

          {/* Right column: relative time (desktop, row layout only). Fades out
          on hover/menu-open, when the meatball takes its place — mirroring
          the sidebar rows. */}
          {layout === "row" && relativeTime && (
            <span
              className={cn(
                "pointer-events-none relative z-0 hidden self-start whitespace-nowrap pt-1 text-right text-sm text-muted-foreground transition-opacity duration-75 md:block",
                menuOpen
                  ? "opacity-0"
                  : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
              )}
              aria-hidden="true"
            >
              {relativeTime}
            </span>
          )}

          {/* Actions menu. In row layout the trigger occupies the timestamp's
          slot (swapping in on hover); in grid layout it sits in the corner. */}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SessionCardActionButton
                open={menuOpen}
                aria-label={t("card.optionsFor", { title: displayTitle })}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute z-10",
                  layout === "row" ? "right-6 top-6" : "right-4 top-4",
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </SessionCardActionButton>
            </DropdownMenuTrigger>
            <SessionActionsMenuContent
              {...menuProps}
              onClose={() => setMenuOpen(false)}
              onRename={
                onRename
                  ? () => {
                      setMenuOpen(false);
                      startRename();
                    }
                  : undefined
              }
              onOpenInWindow={
                onOpenInWindow ? () => onOpenInWindow(id) : undefined
              }
            />
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      {/* Right-click menu at the cursor, same actions as the meatball. */}
      <SessionActionsContextMenuContent
        {...menuProps}
        // The dropdown path closes its menu before starting the rename; the
        // context menu has no such handle, so on the rename path we suppress
        // Radix's close focus restoration instead — otherwise the trigger
        // reclaims focus from the rename input and swallows the user's first
        // keystrokes. Every other close path (Escape, outside click, any other
        // action) must keep the restoration, or keyboard users lose their place
        // in the list and have to navigate back to the session they were on.
        onCloseAutoFocus={(event) => {
          if (!renameInvokedFromContextMenuRef.current) return;
          renameInvokedFromContextMenuRef.current = false;
          event.preventDefault();
        }}
        onRename={
          onRename
            ? () => {
                renameInvokedFromContextMenuRef.current = true;
                startRename();
              }
            : undefined
        }
        onOpenInWindow={onOpenInWindow ? () => onOpenInWindow(id) : undefined}
      />
    </ContextMenu>
  );
}
