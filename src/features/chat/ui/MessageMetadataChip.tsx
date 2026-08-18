import { IconRobot } from "@tabler/icons-react";
import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { AvatarVisual } from "@/shared/ui/avatar-visual";
import { cn } from "@/shared/lib/cn";
import type { MessageChip } from "@/shared/types/messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const messageChipClasses: Record<MessageChip["type"], string> = {
  agent: "bg-chip-agent-bg text-chip-agent-fg",
  skill: "bg-chip-skill-bg text-chip-skill-fg",
  extension: "bg-chip-automation-bg text-chip-automation-fg",
  recipe: "bg-chip-file-bg text-chip-file-fg",
};

function getChipLabel(chip: MessageChip): string {
  if (chip.type !== "agent") {
    return chip.label;
  }

  if (chip.agentRole === "active") {
    return chip.label;
  }

  if (chip.agentRole === "mentioned") {
    return `@${chip.label}`;
  }

  return chip.label;
}

function getChipTitle(chip: MessageChip, chipLabel: string): string {
  if (chip.type !== "agent") {
    return chipLabel;
  }

  if (chip.agentRole === "active") {
    return `${chip.label} received this message`;
  }

  if (chip.agentRole === "mentioned") {
    return `${chip.label} was also tagged in this message`;
  }

  return chipLabel;
}

export function MessageMetadataChip({ chip }: { chip: MessageChip }) {
  const agentPersona = useAgentStore((state) =>
    chip.type === "agent" && chip.id ? state.getPersonaById(chip.id) : null,
  );
  const Icon =
    chip.type === "skill"
      ? SkillIcon
      : chip.type === "agent"
        ? IconRobot
        : null;
  const leadingIcon = Icon ? <Icon className="size-3.5 shrink-0" /> : null;
  const chipLabel = getChipLabel(chip);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-6 max-w-64 items-center gap-1.5 rounded-xs pl-[9px] pr-2 text-xs font-normal",
            messageChipClasses[chip.type],
            chip.type === "agent" &&
              chip.agentRole === "mentioned" &&
              "opacity-80",
          )}
        >
          {chip.type === "agent" ? (
            <AvatarVisual
              avatar={agentPersona?.avatar}
              className="size-3.5 shrink-0 object-contain"
              fallback={leadingIcon}
            />
          ) : (
            leadingIcon
          )}
          <span className="min-w-0 truncate">{chipLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{getChipTitle(chip, chipLabel)}</TooltipContent>
    </Tooltip>
  );
}
