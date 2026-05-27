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
  } = usePinToHomeWidget({ kind: "agent", id: persona.id });
  const avatarTransitionName = getAgentAvatarTransitionName(persona.id);

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || menuOpen) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(persona);
    }
  };

  const optionsMenu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("card.options")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "size-7 shrink-0 rounded-full bg-surface-agent-profile-control-bg text-surface-agent-profile-fg",
            "transition-colors hover:bg-surface-agent-profile-fg hover:text-surface-agent-profile-control-bg",
            "focus-visible:bg-surface-agent-profile-fg focus-visible:text-surface-agent-profile-control-bg",
            "active:bg-surface-agent-profile-fg active:text-surface-agent-profile-control-bg",
            "data-[state=open]:bg-surface-agent-profile-fg data-[state=open]:text-surface-agent-profile-control-bg",
            "aria-expanded:bg-surface-agent-profile-fg aria-expanded:text-surface-agent-profile-control-bg",
            menuOpen &&
              "bg-surface-agent-profile-fg text-surface-agent-profile-control-bg",
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
      >
        <DropdownMenuItem
          onSelect={() => void pinToHome()}
          disabled={isPinnedToHome || isPinningToHome}
        >
          <PinIcon className="size-3.5" />
          {isPinnedToHome
            ? t("common:actions.pinnedToHome")
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

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains nested menu buttons, so a native button is not valid here
    <div
      aria-label={t("card.ariaLabel", { name: persona.displayName })}
      role="button"
      onClick={() => !menuOpen && onSelect?.(persona)}
      onKeyDown={handleCardKeyDown}
      tabIndex={0}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-4",
        "rounded-card bg-transparent p-2",
        "transition-colors duration-200",
        "focus-visible:outline-none",
        isActive && "bg-muted/40",
      )}
    >
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

      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-lg font-medium text-foreground">
            {persona.displayName}
          </span>
          {optionsMenu}
        </div>

        <p className="line-clamp-3 max-w-[28ch] text-xs font-light leading-3 text-muted-foreground">
          {persona.systemPrompt}
        </p>
      </div>
    </div>
  );
});
