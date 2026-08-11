import type { ComponentType, MouseEvent, ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SIDEBAR_SECTION_HEADER_ROW_CLASS } from "@/shared/ui/sidebar-tokens";

/**
 * Reveal-on-hover treatment for header actions. Actions stay hidden until the
 * header row is hovered or focused, and stay visible while a menu opened from
 * the header is still open. Apply to each action rendered inside `actions`.
 */
export const SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS =
  "invisible pointer-events-none group-hover/section-header:visible group-hover/section-header:pointer-events-auto group-focus-within/section-header:visible group-focus-within/section-header:pointer-events-auto focus-visible:visible focus-visible:pointer-events-auto data-[state=open]:visible data-[state=open]:pointer-events-auto";

/**
 * A create-style icon action for section headers (new chat, new project).
 * Renders with the shared pill/icon treatment and hover-reveal behavior so
 * every section uses identical buttons regardless of view.
 */
export function SidebarSectionHeaderAction({
  icon: Icon,
  label,
  onClick,
  revealClassName = SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Visibility/reveal classes. Defaults to the section-header hover reveal;
   * rows with their own hover group (e.g. project rows) pass their own. */
  revealClassName?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      flush
      size="icon-xs"
      onClick={onClick}
      aria-label={label}
      tooltip={label}
      className={cn("size-5", revealClassName)}
    >
      <Icon className="size-4" />
    </Button>
  );
}

interface SidebarSectionHeaderProps {
  /** Section label, e.g. Projects / Chats. */
  label: string;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  /** When provided, the label becomes a collapse toggle with a chevron. */
  onToggleOpen?: () => void;
  /** Expanded state for the collapse toggle; only used with onToggleOpen. */
  isOpen?: boolean;
  /** Hide the chevron while keeping the toggle clickable (e.g. empty state). */
  showChevron?: boolean;
  /** Inline element rendered immediately after the label, before the
   * right-aligned actions (e.g. a one-time info affordance). */
  labelAdornment?: ReactNode;
  /** Right-aligned action cluster (display menu, new project/chat buttons). */
  actions?: ReactNode;
  /** Extra class for the label text. */
  labelClassName?: string;
  /** Extra class for the header row. */
  className?: string;
  /** Overlay content such as drag-over indicators. */
  children?: ReactNode;
}

/**
 * Shared header row for sidebar session-list sections (Projects, Chats, and
 * the flat chat list). Owns the row layout, the optional collapse toggle, and
 * the action cluster so each section renders the same structure.
 */
export function SidebarSectionHeader({
  label,
  collapsed,
  labelTransition,
  labelVisible,
  onToggleOpen,
  isOpen = true,
  showChevron = true,
  labelAdornment,
  actions,
  labelClassName,
  className,
  children,
}: SidebarSectionHeaderProps) {
  const labelVisibilityClass = labelVisible
    ? "opacity-100 w-auto"
    : "opacity-0 w-0 overflow-hidden";

  return (
    <div
      className={cn(
        "relative group/section-header flex items-center",
        collapsed
          ? "px-0 pt-0 pb-1 justify-center"
          : SIDEBAR_SECTION_HEADER_ROW_CLASS,
        className,
      )}
    >
      {!collapsed &&
        (onToggleOpen ? (
          <Button
            type="button"
            variant="ghost"
            flush
            size="xs"
            onClick={onToggleOpen}
            aria-expanded={isOpen}
            className={cn(
              "h-7 min-w-0 justify-start gap-0.5",
              !labelAdornment && "flex-1",
              labelTransition,
              labelVisibilityClass,
            )}
          >
            <span className={cn("truncate", labelClassName)}>{label}</span>
            {showChevron && (
              <IconChevronDown
                className={cn(
                  "invisible size-3 shrink-0 transition-transform duration-150",
                  "group-hover/section-header:visible",
                  !isOpen && "-rotate-90",
                )}
              />
            )}
          </Button>
        ) : (
          <span
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center truncate text-muted-foreground",
              labelClassName,
              labelTransition,
              labelVisibilityClass,
            )}
          >
            {label}
          </span>
        ))}
      {!collapsed && labelAdornment ? (
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center",
            labelTransition,
            labelVisible
              ? "opacity-100"
              : "opacity-0 overflow-hidden pointer-events-none",
          )}
        >
          {labelAdornment}
        </div>
      ) : null}
      {!collapsed && actions ? (
        <div className="ml-1 flex items-center gap-1">{actions}</div>
      ) : null}
      {children}
    </div>
  );
}
