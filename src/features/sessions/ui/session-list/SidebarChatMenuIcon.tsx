import { SidebarNavChatsIcon } from "@/features/navigation/ui/sidebarNavIcons";
import { cn } from "@/shared/lib/cn";

/** The canonical chat glyph and foreground treatment for every sidebar chat row. */
export function SidebarChatMenuIcon({
  className,
  testId = "sidebar-chat-menu-icon",
}: {
  className?: string;
  /** Rows that use this as a project-column fallback do not expose chat-icon test hooks. */
  testId?: string;
}) {
  return (
    <SidebarNavChatsIcon
      data-testid={testId}
      className={cn("text-sidebar-foreground", className)}
    />
  );
}
