import { useTranslation } from "react-i18next";
import { SIDEBAR_UNREAD_DOT_CLASS } from "@/shared/ui/sidebar-tokens";
import { cn } from "@/shared/lib/cn";

/** Unread indicator aligned to the section divider inset on the right. */
export function SidebarUnreadDot({ className }: { className?: string }) {
  const { t } = useTranslation("sidebar");

  return (
    <span
      role="status"
      aria-label={t("status.unreadMessages")}
      className={cn(SIDEBAR_UNREAD_DOT_CLASS, className)}
    />
  );
}
