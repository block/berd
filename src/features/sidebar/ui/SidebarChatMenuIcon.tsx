import { SidebarNavChatsIcon } from "./sidebarNavIcons";

export function SidebarChatMenuIcon({ className }: { className?: string }) {
  return (
    <SidebarNavChatsIcon
      data-testid="sidebar-chat-menu-icon"
      className={className}
    />
  );
}
