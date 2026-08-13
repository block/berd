import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/shared/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

type ComposerChipTone = "file" | "quote" | "agent" | "skill" | "automation";

const toneClasses: Record<ComposerChipTone, string> = {
  file: "bg-chip-file-bg text-chip-file-fg hover:bg-chip-file-bg",
  quote: "bg-chip-chat-bg text-chip-chat-fg hover:bg-chip-chat-bg",
  agent: "bg-chip-agent-bg text-chip-agent-fg hover:bg-chip-agent-bg",
  skill: "bg-chip-skill-bg text-chip-skill-fg hover:bg-chip-skill-bg",
  automation:
    "bg-chip-automation-bg text-chip-automation-fg hover:bg-chip-automation-bg",
};

interface ComposerChipProps {
  tone: ComposerChipTone;
  label: string;
  removeLabel?: string;
  onRemove?: () => void;
  leading?: ReactNode;
  title?: ReactNode;
  /** Rich preview panel shown on hover in place of the plain tooltip.
   * Rendered on the dark tooltip surface; unlike a Tooltip it stays open
   * while the pointer moves into it, so it can host scrollable content. */
  details?: ReactNode;
  className?: string;
}

export function ComposerChip({
  tone,
  label,
  removeLabel,
  onRemove,
  leading,
  title,
  details,
  className,
}: ComposerChipProps) {
  const chip = (
    <span
      className={cn(
        "group inline-flex h-6 max-w-64 items-center gap-1.5 rounded-xs pl-[9px] pr-2 text-xs font-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        toneClasses[tone],
        className,
      )}
      // With a details panel the chip is the only path to the full content
      // (e.g. a quoted passage whose source was compacted away), so it must
      // be reachable by keyboard: focusing the trigger opens the HoverCard.
      {...(details ? { tabIndex: 0 } : {})}
    >
      {onRemove && removeLabel ? (
        <button
          type="button"
          onClick={onRemove}
          className="group/remove relative flex size-3.5 shrink-0 items-center justify-center rounded-full text-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={removeLabel}
        >
          {leading ? (
            <span className="flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {leading}
            </span>
          ) : null}
          <X className="absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-45 group-focus-within:opacity-45 group-hover/remove:opacity-100 group-focus-visible/remove:opacity-100" />
        </button>
      ) : leading ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );

  if (details) {
    return (
      <HoverCard openDelay={300} closeDelay={150}>
        <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
        <HoverCardContent variant="tooltip" align="start" className="w-80">
          {details}
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{title ?? label}</TooltipContent>
    </Tooltip>
  );
}
