import { useTranslation } from "react-i18next";
import { IconDots } from "@tabler/icons-react";
import { Pencil, PinIcon, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { SidebarRowMenuButton } from "@/shared/ui/sidebar-row-menu-button";
import { SIDEBAR_INVERSE_MENU_CONTENT_CLASS } from "@/shared/ui/sidebar-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";

interface SidebarItemMenuProps {
  label: string;
  onOpenChange?: (open: boolean) => void;
  onPinToHome?: () => void;
  pinToHomeDisabled?: boolean;
  pinToHomeLabel?: string;
  isPinnedToHome?: boolean;
  onEdit?: () => void;
  onArchive?: () => void;
}

export function SidebarItemMenu({
  label,
  onOpenChange,
  onPinToHome,
  pinToHomeDisabled = false,
  pinToHomeLabel,
  isPinnedToHome = false,
  onEdit,
  onArchive,
}: SidebarItemMenuProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const [open, setOpen] = useExclusiveMenu();
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <SidebarRowMenuButton
          aria-label={t("menu.optionsFor", { label })}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "size-5",
            open
              ? "visible opacity-100"
              : "invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100",
          )}
        >
          <IconDots className="size-4" />
        </SidebarRowMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        variant="inverse"
        align="start"
        alignOffset={-4}
        sideOffset={4}
        className={SIDEBAR_INVERSE_MENU_CONTENT_CLASS}
      >
        {onPinToHome && (
          <DropdownMenuItem onClick={onPinToHome} disabled={pinToHomeDisabled}>
            <PinIcon
              className="size-3.5"
              fill={isPinnedToHome ? "currentColor" : "none"}
            />
            {pinToHomeLabel ?? t("common:actions.pinToHome")}
          </DropdownMenuItem>
        )}
        {onEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" />
            {t("common:actions.edit")}
          </DropdownMenuItem>
        )}
        {onArchive && (
          <DropdownMenuItem onClick={onArchive}>
            <Trash2 className="size-3.5" />
            {t("common:actions.archive")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
