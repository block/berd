import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCopy,
  IconDownload,
  IconDots,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
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

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || menuOpen) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(persona);
    }
  };

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
      <div className="relative aspect-square w-full overflow-hidden rounded-card-sm">
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

        <div className="absolute right-1 top-1 z-20">
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
                  "size-5 rounded-full transition-colors hover:text-foreground",
                  menuOpen
                    ? "opacity-100 text-foreground"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-foreground/40",
                )}
              >
                <IconDots className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              variant="inverse"
              align="start"
              alignOffset={-4}
              sideOffset={4}
            >
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
        </div>
      </div>

      <div className="flex flex-col gap-3 px-1">
        <div className="h-px w-full bg-border/80" />

        <div className="flex items-center">
          <span className="inline-flex h-5 items-center rounded-full bg-background px-1.5 py-0.5 text-sm leading-[15px] text-foreground">
            {persona.displayName}
          </span>
        </div>

        <p className="line-clamp-3 max-w-[28ch] text-base font-light leading-5 text-muted-foreground">
          {persona.systemPrompt}
        </p>
      </div>
    </div>
  );
});
