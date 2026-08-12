import type { ComponentProps, ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconDots } from "@tabler/icons-react";
import { Pencil, PinIcon, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { SidebarRowMenuButton } from "@/shared/ui/sidebar-row-menu-button";
import { SIDEBAR_RAISED_MENU_CONTENT_CLASS } from "@/shared/ui/sidebar-tokens";
import { ContextMenuContent, ContextMenuItem } from "@/shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";

type MenuItemComponent = ComponentType<{
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}>;

/**
 * Actions for a sidebar row that owns an entity (today: projects). The same
 * action set is reachable from the row's overflow ("…") menu and from
 * right-clicking the row, so the two entry points can never drift apart.
 */
export interface SidebarItemMenuActions {
  onPinToHome?: () => void;
  pinToHomeDisabled?: boolean;
  pinToHomeLabel?: string;
  isPinnedToHome?: boolean;
  onEdit?: () => void;
  onArchive?: () => void;
}

interface SidebarItemMenuProps extends SidebarItemMenuActions {
  label: string;
  onOpenChange?: (open: boolean) => void;
}

function SidebarItemMenuItems({
  Item,
  onPinToHome,
  pinToHomeDisabled = false,
  pinToHomeLabel,
  isPinnedToHome = false,
  onEdit,
  onArchive,
}: SidebarItemMenuActions & { Item: MenuItemComponent }) {
  const { t } = useTranslation(["sidebar", "common"]);

  return (
    <>
      {onPinToHome && (
        <Item onClick={onPinToHome} disabled={pinToHomeDisabled}>
          <PinIcon
            className="size-3.5"
            fill={isPinnedToHome ? "currentColor" : "none"}
          />
          {pinToHomeLabel ?? t("common:actions.pinToHome")}
        </Item>
      )}
      {onEdit && (
        <Item onClick={onEdit}>
          <Pencil className="size-3.5" />
          {t("common:actions.edit")}
        </Item>
      )}
      {onArchive && (
        <Item onClick={onArchive}>
          <Trash2 className="size-3.5" />
          {t("common:actions.archive")}
        </Item>
      )}
    </>
  );
}

/** Right-click surface for a sidebar item row; mirrors the overflow menu. */
export function SidebarItemContextMenuContent({
  className,
  ...actions
}: SidebarItemMenuActions &
  Omit<ComponentProps<typeof ContextMenuContent>, "children" | "variant">) {
  return (
    <ContextMenuContent
      variant="raised"
      className={cn(SIDEBAR_RAISED_MENU_CONTENT_CLASS, className)}
    >
      <SidebarItemMenuItems {...actions} Item={ContextMenuItem} />
    </ContextMenuContent>
  );
}

export function SidebarItemMenu({
  label,
  onOpenChange,
  ...actions
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
        variant="raised"
        align="start"
        alignOffset={-4}
        sideOffset={4}
        className={SIDEBAR_RAISED_MENU_CONTENT_CLASS}
      >
        <SidebarItemMenuItems {...actions} Item={DropdownMenuItem} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
