import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCopy,
  IconDownload,
  IconDots,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { PinIcon } from "lucide-react";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import type { Persona } from "@/shared/types/agents";
import {
  canDeletePersona,
  canEditPersona,
} from "@/features/agents/lib/personaPresentation";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { getAgentAvatarTransitionName } from "@/features/agents/lib/agentViewTransitions";

interface PersonaCardProps {
  persona: Persona;
  onSelect?: (persona: Persona) => void;
  onStartChat?: (persona: Persona) => void;
  onEdit?: (persona: Persona) => void;
  onDuplicate?: (persona: Persona) => void;
  onDelete?: (persona: Persona) => void;
  onExport?: (persona: Persona) => void;
  isActive?: boolean;
}

/**
 * Agents-page persona tile. Layout matches Figma 916:17434:
 *   - Large illustrated PNG avatar (square, ~260px)
 *   - Horizontal divider
 *   - Name in a small pill chip
 *   - 2-line description below
 *
 * The avatar is a deterministic 1-of-4 PNG keyed off persona.id.
 */
export const PersonaCard = memo(function PersonaCard({
  persona,
  onSelect,
  onStartChat,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
  isActive = false,
}: PersonaCardProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [menuOpen, setMenuOpen] = useState(false);

  const avatarMedia = useAvatarMedia(persona.avatar);
  const fallbackIconSrc = resolveAgentIcon(persona.id);
  const isEditable = canEditPersona(persona);
  const isDeletable = canDeletePersona(persona);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "agent", id: persona.id });
  const avatarTransitionName = getAgentAvatarTransitionName(persona.id);

  const optionsMenu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="agent-tile-action"
          size="icon-xs"
          aria-label={t("card.options")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "size-7 shrink-0 rounded-full opacity-0 pointer-events-none",
            "transition-[opacity,background-color,color,backdrop-filter] duration-200",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "focus-visible:pointer-events-auto focus-visible:opacity-100",
            "data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
          )}
        >
          <IconDots className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        variant="inverse"
        align="end"
        alignOffset={-2}
        sideOffset={4}
        className="shadow-mini"
      >
        <DropdownMenuItem
          onSelect={() => (isPinnedToHome ? unpinFromHome() : void pinToHome())}
          disabled={isPinningToHome}
        >
          <PinIcon className="size-3.5" />
          {isPinnedToHome
            ? t("common:actions.unpinFromHome")
            : isPinningToHome
              ? t("common:actions.pinningToHome")
              : t("common:actions.pinToHome")}
        </DropdownMenuItem>
        {isEditable && (
          <DropdownMenuItem onSelect={() => onEdit?.(persona)}>
            <IconPencil className="size-3.5" />
            {t("common:actions.edit")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onDuplicate?.(persona)}>
          <IconCopy className="size-3.5" />
          {t("common:actions.duplicate")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onExport?.(persona)}>
          <IconDownload className="size-3.5" />
          {t("common:actions.export")}
        </DropdownMenuItem>
        {isDeletable && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onDelete?.(persona)}
          >
            <IconTrash className="size-3.5" />
            {t("common:actions.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const hoverActionsOverlay =
    onSelect || onStartChat ? (
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-6 z-10 flex items-center justify-center gap-2 opacity-0",
          "transition-opacity duration-200",
          "group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        {onSelect ? (
          <Button
            type="button"
            variant="agent-tile-action"
            size="sm"
            onClick={() => onSelect(persona)}
            aria-label={t("card.viewAria", { name: persona.displayName })}
            className="pointer-events-auto rounded-full"
          >
            {t("card.view")}
          </Button>
        ) : null}
        {onStartChat ? (
          <Button
            type="button"
            variant="agent-tile-action"
            size="sm"
            onClick={() => onStartChat(persona)}
            aria-label={t("card.chatAria", { name: persona.displayName })}
            className="pointer-events-auto rounded-full"
          >
            {t("card.chat")}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col gap-4",
        "rounded-card bg-transparent p-2",
        "transition-colors duration-200",
        isActive && "bg-muted/40",
      )}
    >
      <div className="relative">
        <div
          className="relative aspect-square w-full overflow-hidden rounded-card-sm"
          style={{ viewTransitionName: avatarTransitionName }}
        >
          {avatarMedia ? (
            <AvatarMedia
              media={avatarMedia}
              alt={persona.displayName}
              lazy
              loadingStrategy="visible-video"
              className={cn(
                "object-contain transition-transform duration-300",
                "group-hover:scale-[1.02]",
              )}
            />
          ) : (
            <img
              alt=""
              aria-hidden="true"
              src={fallbackIconSrc}
              className={cn(
                "pointer-events-none size-full object-contain transition-transform duration-300",
                "group-hover:scale-[1.02]",
              )}
            />
          )}
        </div>
        {hoverActionsOverlay}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-base font-normal leading-5 text-foreground">
            {persona.displayName}
          </span>
          {optionsMenu}
        </div>

        <p className="line-clamp-3 max-w-[28ch] text-xs font-normal leading-4 text-muted-foreground">
          {persona.systemPrompt}
        </p>
      </div>
    </div>
  );
});
