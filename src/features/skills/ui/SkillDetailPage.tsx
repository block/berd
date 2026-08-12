import { useTranslation } from "react-i18next";
import {
  IconDots,
  IconFolderOpen,
  IconMessagePlus,
  IconPencil,
  IconShare,
  IconTrash,
} from "@tabler/icons-react";
import { PinIcon } from "lucide-react";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { AgentProfileLayout } from "@/features/agents/ui/AgentProfileLayout";
import { AgentIdentityRail } from "@/features/agents/ui/AgentIdentityRail";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { SkillInfo } from "../api/skills";

interface SkillDetailPageProps {
  skill: SkillInfo | null;
  onEdit: (skill: SkillInfo) => void;
  onReveal: (skill: SkillInfo) => void;
  onShare: (skill: SkillInfo) => void;
  onStartChat?: (skill: SkillInfo) => void;
  onDelete: (skill: SkillInfo) => void;
}

const INSTRUCTIONS_LABEL_CLASS =
  "text-xs leading-4 font-medium text-surface-agent-profile-fg-muted";
const INSTRUCTIONS_PANEL_CLASS =
  "min-h-[24rem] w-full overflow-y-auto rounded-md bg-card p-4 text-sm leading-relaxed text-surface-agent-profile-fg lg:min-h-[29rem]";
const ACTION_BUTTON_CLASS =
  "size-9 rounded-full bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover";
const PRIMARY_ACTION_BUTTON_CLASS =
  "size-9 rounded-full !bg-surface-agent-profile-fg !text-surface-agent-profile-control-bg hover:!bg-surface-agent-profile-action-bg-hover";
const ACTION_ICON_CLASS = "size-3.5";

export function SkillDetailPage({
  skill,
  onEdit,
  onReveal,
  onShare,
  onStartChat,
  onDelete,
}: SkillDetailPageProps) {
  const { t } = useTranslation(["skills", "common"]);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({
    kind: "skill",
    id: skill?.id,
    legacyIds: skill?.legacyPinIds,
  });

  if (!skill) {
    return (
      <div className="flex h-full flex-col justify-center px-1 text-sm text-muted-foreground">
        <p className="text-sm text-foreground">{t("view.detailEmptyTitle")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("view.detailEmptyDescription")}
        </p>
      </div>
    );
  }

  const sourceLabels =
    skill.projectLinks.length > 0
      ? [...new Set(skill.projectLinks.map((project) => project.name))]
      : [skill.sourceLabel];
  const startChatLabel = t("view.startChatShort");
  const pinLabel = isPinnedToHome
    ? t("common:actions.unpinFromHome")
    : isPinningToHome
      ? t("common:actions.pinningToHome")
      : t("common:actions.pinToHome");
  const editLabel = t("common:actions.edit");
  const revealLabel = t("view.reveal");
  const moreLabel = t("view.more");
  const isReadonly = skill.readonly;

  const actions = (
    <>
      {!isReadonly ? (
        <Button
          type="button"
          size="icon"
          aria-label={editLabel}
          tooltip={editLabel}
          onClick={() => onEdit(skill)}
          className={PRIMARY_ACTION_BUTTON_CLASS}
        >
          <IconPencil className={ACTION_ICON_CLASS} />
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={pinLabel}
        tooltip={pinLabel}
        onClick={() => (isPinnedToHome ? unpinFromHome() : void pinToHome())}
        disabled={isPinningToHome}
        className={ACTION_BUTTON_CLASS}
      >
        <PinIcon
          className={ACTION_ICON_CLASS}
          fill={isPinnedToHome ? "currentColor" : "none"}
        />
      </Button>
      {onStartChat ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={startChatLabel}
          tooltip={startChatLabel}
          onClick={() => onStartChat(skill)}
          className={ACTION_BUTTON_CLASS}
        >
          <IconMessagePlus className={ACTION_ICON_CLASS} />
        </Button>
      ) : null}
      {!isReadonly ? (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={revealLabel}
            tooltip={revealLabel}
            onClick={() => onReveal(skill)}
            className={ACTION_BUTTON_CLASS}
          >
            <IconFolderOpen className={ACTION_ICON_CLASS} />
          </Button>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={moreLabel}
                    className={ACTION_BUTTON_CLASS}
                  >
                    <IconDots className={ACTION_ICON_CLASS} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{moreLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent variant="raised" align="end" sideOffset={8}>
              <DropdownMenuItem onSelect={() => onShare(skill)}>
                <IconShare className="size-3.5" />
                {t("view.share")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDelete(skill)}
              >
                <IconTrash className="size-3.5" />
                {t("common:actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </>
  );

  const metadata = [
    {
      label: t("view.source"),
      value: sourceLabels.join(" · "),
    },
    ...(skill.projectLinks.length > 0
      ? [
          {
            label: t("view.projects"),
            value: skill.projectLinks
              .map((project) => project.name)
              .join(" · "),
          },
        ]
      : []),
    ...(isReadonly
      ? []
      : [
          {
            label: t("view.location"),
            value: skill.fileLocation,
            wrap: true,
          },
        ]),
  ];

  return (
    <AgentProfileLayout
      animateSections={false}
      identityRail={
        <AgentIdentityRail
          className="pt-6"
          title={skill.name}
          description={skill.description}
          metadata={metadata}
          actions={actions}
        />
      }
    >
      <section className="space-y-3 pt-6" aria-labelledby="skill-instructions">
        <h2 id="skill-instructions" className={INSTRUCTIONS_LABEL_CLASS}>
          {t("view.instructions")}
        </h2>
        <div className={INSTRUCTIONS_PANEL_CLASS}>
          <MessageResponse className="min-w-0 text-sm leading-relaxed">
            {skill.instructions || " "}
          </MessageResponse>
        </div>
      </section>
    </AgentProfileLayout>
  );
}
