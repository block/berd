import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import { cn } from "@/shared/lib/cn";
import type { MessageChip } from "@/shared/types/messages";

const messageChipClasses: Record<MessageChip["type"], string> = {
  skill: "bg-chip-skill-bg text-chip-skill-fg",
  extension: "bg-chip-automation-bg text-chip-automation-fg",
  recipe: "bg-chip-file-bg text-chip-file-fg",
};

export function MessageMetadataChip({ chip }: { chip: MessageChip }) {
  const Icon = chip.type === "skill" ? SkillIcon : null;

  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-64 items-center gap-1.5 rounded-full pl-[9px] pr-2 text-xs font-normal",
        messageChipClasses[chip.type],
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{chip.label}</span>
    </span>
  );
}
