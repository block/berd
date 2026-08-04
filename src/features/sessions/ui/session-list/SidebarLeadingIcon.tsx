import type { MouseEventHandler, ReactNode } from "react";
import { IconPin } from "@tabler/icons-react";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SidebarUnreadDot } from "./SidebarUnreadDot";

interface SidebarLeadingIconQuickPin {
  pinned: boolean;
  disabled?: boolean;
  persistWhenPinned?: boolean;
  pinLabel: string;
  unpinLabel: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

/**
 * One sidebar row leading slot. It renders exactly one visible state at a time:
 * running > unread > pinned/hover pin > base identity.
 */
export function SidebarLeadingIcon({
  children,
  isRunning = false,
  hasUnread = false,
  quickPin,
  activeLabel,
  unreadLabel,
  className,
  baseClassName,
  testId,
}: {
  children?: ReactNode;
  isRunning?: boolean;
  hasUnread?: boolean;
  quickPin?: SidebarLeadingIconQuickPin;
  activeLabel: string;
  unreadLabel: string;
  className?: string;
  baseClassName?: string;
  testId?: string;
}) {
  const quickPinLabel = quickPin?.pinned
    ? quickPin.unpinLabel
    : quickPin?.pinLabel;

  return (
    <span
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center",
        className,
      )}
      data-testid={testId}
    >
      {isRunning ? (
        <span
          role="status"
          aria-label={activeLabel}
          className="flex size-full items-center justify-center text-sidebar-foreground"
        >
          <ActiveChatBerdIndicator respectAnimationPreference size={16} />
        </span>
      ) : hasUnread ? (
        <span
          role="status"
          aria-label={unreadLabel}
          className="flex size-full items-center justify-center"
        >
          <SidebarUnreadDot />
        </span>
      ) : (
        <>
          {children != null ? (
            <span
              aria-hidden="true"
              className={cn(
                "flex size-full items-center justify-center transition-opacity duration-150",
                quickPin &&
                  "group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0",
                quickPin?.pinned &&
                  quickPin.persistWhenPinned !== false &&
                  "opacity-0",
                baseClassName,
              )}
            >
              {children}
            </span>
          ) : null}
          {quickPin ? (
            <span
              className={cn(
                "absolute inset-0 opacity-0 transition-opacity duration-150",
                "pointer-events-none group-hover/chat-row:pointer-events-auto group-hover/chat-row:opacity-100 group-focus-within/chat-row:pointer-events-auto group-focus-within/chat-row:opacity-100",
                quickPin.pinned &&
                  quickPin.persistWhenPinned !== false &&
                  "pointer-events-auto opacity-100",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                data-sidebar-drag-ignore
                aria-label={quickPinLabel}
                tooltip={quickPinLabel}
                disabled={quickPin.disabled}
                tabIndex={
                  quickPin.pinned && quickPin.persistWhenPinned !== false
                    ? undefined
                    : -1
                }
                onClick={quickPin.onClick}
                className="size-full"
              >
                <IconPin className="size-4" />
              </Button>
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}
