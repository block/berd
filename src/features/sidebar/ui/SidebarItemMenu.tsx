import { useTranslation } from "react-i18next";
import { IconDots } from "@tabler/icons-react";
import { Pencil, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
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
  onEdit?: () => void;
  onArchive?: () => void;
}

export function SidebarItemMenu({
  label,
  onOpenChange,
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("menu.optionsFor", { label })}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "size-6 rounded-md",
            open
              ? "visible opacity-100"
              : "invisible group-hover:visible group-focus-within:visible opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <IconDots className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={8}>
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
