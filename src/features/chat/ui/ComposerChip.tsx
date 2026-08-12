import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

type ComposerChipTone = "file" | "agent" | "skill" | "automation";

const toneClasses: Record<ComposerChipTone, string> = {
  file: "bg-chip-file-bg text-chip-file-fg hover:bg-chip-file-bg",
  agent: "bg-chip-agent-bg text-chip-agent-fg hover:bg-chip-agent-bg",
  skill: "bg-chip-skill-bg text-chip-skill-fg hover:bg-chip-skill-bg",
  automation:
    "bg-chip-automation-bg text-chip-automation-fg hover:bg-chip-automation-bg",
};

interface ComposerChipProps {
  tone: ComposerChipTone;
  label: string;
  removeLabel: string;
  onRemove: () => void;
  leading?: ReactNode;
  title?: string;
  className?: string;
}

export function ComposerChip({
  tone,
  label,
  removeLabel,
  onRemove,
  leading,
  title,
  className,
}: ComposerChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "group inline-flex h-6 max-w-64 items-center gap-1.5 rounded-xs pl-[9px] pr-2 text-xs font-normal transition-colors",
            toneClasses[tone],
            className,
          )}
        >
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
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{title ?? label}</TooltipContent>
    </Tooltip>
  );
}
