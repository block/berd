import { SIDEBAR_UNREAD_DOT_CLASS } from "@/shared/ui/sidebar-tokens";
import { cn } from "@/shared/lib/cn";

/**
 * Bare unread indicator dot. The parent owns positioning (e.g. placing it in a
 * row's left icon slot) and accessibility labeling via `role="status"`.
 */
export function SidebarUnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(SIDEBAR_UNREAD_DOT_CLASS, className)}
    />
  );
}
