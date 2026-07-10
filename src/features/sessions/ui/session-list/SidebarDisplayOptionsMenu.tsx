import { IconDots } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  SIDEBAR_ACTION_ICON_CLASS,
  SIDEBAR_INVERSE_MENU_CONTENT_CLASS,
  SIDEBAR_SECTION_ACTION_PILL_CLASS,
} from "@/shared/ui/sidebar-tokens";

interface SidebarDisplayOptionsMenuProps {
  /** Sidebar-namespace translation key for the trigger's aria-label/title
   * (e.g. actions.chatDisplayOptions, actions.projectDisplayOptions). */
  labelKey: string;
  /** Omit for layouts that always show a project identity icon (flat chats). */
  showChatIcons?: boolean;
  onShowChatIconsChange?: (show: boolean) => void;
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
  showGitBranches?: boolean;
  onShowGitBranchesChange?: (show: boolean) => void;
  className?: string;
}

function CheckableMenuItem({
  checked,
  children,
  onCheckedChange,
}: {
  checked: boolean;
  children: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "justify-between gap-3 py-1.5 pr-2 pl-2 text-popover-inverse-foreground opacity-[0.85] focus:!bg-transparent focus:!text-popover-inverse-foreground focus:opacity-100",
        "[&>span:first-child]:right-2 [&>span:first-child]:left-auto",
        "[&>span:first-child_svg]:size-3.5",
      )}
    >
      <span className="min-w-0 flex-1 text-left">{children}</span>
    </DropdownMenuCheckboxItem>
  );
}

/**
 * Shared display-options dropdown for sidebar section headers (Projects,
 * Chats, and the flat chat list). One implementation so the option list
 * cannot drift between sections; only the trigger label differs.
 */
export function SidebarDisplayOptionsMenu({
  labelKey,
  showChatIcons,
  onShowChatIconsChange,
  showTimestamps,
  onShowTimestampsChange,
  showGitBranches = false,
  onShowGitBranchesChange,
  className,
}: SidebarDisplayOptionsMenuProps) {
  const { t } = useTranslation("sidebar");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t(labelKey)}
          title={t(labelKey)}
          className={cn(
            SIDEBAR_SECTION_ACTION_PILL_CLASS,
            SIDEBAR_ACTION_ICON_CLASS,
            "size-5 bg-transparent p-0",
            className,
          )}
        >
          <IconDots className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        variant="inverse"
        className={cn("w-48", SIDEBAR_INVERSE_MENU_CONTENT_CLASS)}
      >
        {onShowChatIconsChange ? (
          <CheckableMenuItem
            checked={showChatIcons ?? false}
            onCheckedChange={onShowChatIconsChange}
          >
            {t("actions.showChatIcons")}
          </CheckableMenuItem>
        ) : null}
        <CheckableMenuItem
          checked={showTimestamps}
          onCheckedChange={onShowTimestampsChange}
        >
          {t("actions.showTimestamp")}
        </CheckableMenuItem>
        {onShowGitBranchesChange ? (
          <CheckableMenuItem
            checked={showGitBranches}
            onCheckedChange={onShowGitBranchesChange}
          >
            {t("actions.showGitBranches")}
          </CheckableMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
