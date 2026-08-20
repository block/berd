import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  Copy,
  Download,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  PinIcon,
  Share2,
  Trash2,
} from "lucide-react";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { SIDEBAR_RAISED_MENU_CONTENT_CLASS } from "@/shared/ui/sidebar-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import type { Persona } from "@/shared/types/agents";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaProviderLabel,
  getRealPersonaDescription,
} from "@/features/agents/lib/personaPresentation";
import {
  AGENT_PROFILE_FIELDS_TRANSITION_NAME,
  getAgentAvatarTransitionName,
} from "@/features/agents/lib/agentViewTransitions";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { AgentProfileLayout } from "@/features/agents/ui/AgentProfileLayout";
import { AgentIdentityRail } from "@/features/agents/ui/AgentIdentityRail";
import { useAvatarLibrary } from "@/features/agents/hooks/useAvatarLibrary";
import { AvatarCollectionOverlay } from "@/features/agents/ui/AvatarCollectionOverlay";
import {
  AVATAR_CUSTOMIZE_LABEL_CLASS,
  AVATAR_CUSTOMIZE_SURFACE_CLASS,
  AVATAR_CUSTOMIZE_TRIGGER_CLASS,
} from "@/features/agents/ui/avatarCustomizeMotion";

interface AgentDetailPageProps {
  persona: Persona;
  onBack: () => void;
  onStartChat?: (persona: Persona) => void;
  onEdit: (persona: Persona) => void;
  onDuplicate: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onExport: (persona: Persona) => void | Promise<void>;
  onShare?: (persona: Persona) => void;
  onAvatarUpdate: (persona: Persona, avatar: string | null) => Promise<void>;
}

const CONTEXT_LABEL_CLASS =
  "text-sm leading-5 font-normal text-surface-agent-profile-fg-muted";
const SECONDARY_ACTION_CLASS =
  "bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover hover:text-surface-agent-profile-fg";
const OVERFLOW_TRIGGER_CLASS =
  "bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover";
const ACTION_ICON_CLASS = "size-3";
const INSTRUCTIONS_PANEL_CLASS =
  "relative h-[min(32rem,calc(100vh-var(--spacing-app-top-bar)-7rem))] min-h-0 w-full overflow-hidden rounded-md bg-surface-agent-profile-control-bg text-sm leading-relaxed text-surface-agent-profile-fg shadow-none";
const INSTRUCTIONS_SCROLL_CLASS =
  "agent-instructions-scrollbar h-full overflow-y-auto overscroll-contain rounded-[inherit] p-4 outline-none scrollbar-visible focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function AgentDetailPage({
  persona,
  onBack,
  onStartChat,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
  onShare,
  onAvatarUpdate,
}: AgentDetailPageProps) {
  const { t } = useTranslation(["agents", "common"]);
  const acpProviders = useAgentStore((s) => s.providers);
  const isEditable = canEditPersona(persona);
  const isDeletable = canDeletePersona(persona);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "agent", id: persona.id });
  const personaAvatarValue = normalizeAvatarUrl(persona.avatar) ?? "";
  const [avatarValue, setAvatarValue] = useState(personaAvatarValue);
  const [, setAvatarPreviewFailed] = useState(false);
  const [avatarSavePending, setAvatarSavePending] = useState(false);
  const [showAvatarOverlay, setShowAvatarOverlay] = useState(false);
  const [previousPersonaAvatarValue, setPreviousPersonaAvatarValue] =
    useState(personaAvatarValue);
  const [previousPersonaId, setPreviousPersonaId] = useState(persona.id);
  const avatarLibrary = useAvatarLibrary(isEditable);
  const normalizedAvatarValue = normalizeAvatarUrl(avatarValue.trim());
  const avatarMedia = useAvatarMedia(normalizedAvatarValue ?? null);
  const descriptionValue = getRealPersonaDescription(persona);
  const providerLabel = getPersonaProviderLabel(
    persona.provider,
    acpProviders,
    t("common:labels.default"),
  );
  const modelLabel = persona.model || t("common:labels.default");
  const createdLabel = persona.createdAt ? formatDate(persona.createdAt) : null;
  const updatedLabel = persona.updatedAt ? formatDate(persona.updatedAt) : null;
  const avatarTransitionName = getAgentAvatarTransitionName(persona.id);
  const fallbackAvatarSrc = resolveAgentIcon(persona.id);
  const metadata = [
    descriptionValue
      ? {
          label: t("view.description", { defaultValue: "Description" }),
          value: descriptionValue,
          multiline: true,
        }
      : null,
    { label: t("editor.provider"), value: providerLabel },
    { label: t("editor.model"), value: modelLabel },
    createdLabel ? { label: t("view.created"), value: createdLabel } : null,
    updatedLabel ? { label: t("view.updated"), value: updatedLabel } : null,
  ].filter(Boolean) as Array<{
    label: string;
    value: string;
    multiline?: boolean;
  }>;

  if (previousPersonaAvatarValue !== personaAvatarValue) {
    setPreviousPersonaAvatarValue(personaAvatarValue);
    setAvatarValue(personaAvatarValue);
    setAvatarPreviewFailed(false);
  }

  if (previousPersonaId !== persona.id) {
    setPreviousPersonaId(persona.id);
    setShowAvatarOverlay(false);
  }

  const handleOpenAvatarSection = useCallback(() => {
    setShowAvatarOverlay(true);
  }, []);

  const commitAvatar = useCallback(
    async (nextAvatar: string | null) => {
      if (!onAvatarUpdate || !isEditable || avatarSavePending) {
        return;
      }

      setAvatarSavePending(true);
      try {
        await onAvatarUpdate(persona, nextAvatar);
        setAvatarValue(nextAvatar ?? "");
        setAvatarPreviewFailed(false);
      } catch (error) {
        setAvatarValue(personaAvatarValue);
        throw error;
      } finally {
        setAvatarSavePending(false);
      }
    },
    [
      avatarSavePending,
      isEditable,
      onAvatarUpdate,
      persona,
      personaAvatarValue,
    ],
  );

  const handleSelectOverlayAvatar = useCallback(
    async (nextAvatarRef: string) => {
      setAvatarValue(nextAvatarRef);
      setAvatarPreviewFailed(false);
      await commitAvatar(nextAvatarRef);
    },
    [commitAvatar],
  );

  const handleCloseAvatarOverlay = useCallback(() => {
    setShowAvatarOverlay(false);
  }, []);

  const avatarPreview = (
    <div className={AVATAR_CUSTOMIZE_SURFACE_CLASS}>
      <div
        className="h-full w-full"
        // The gallery takeover's funnel exit collapses toward this preview,
        // so selecting an avatar visibly lands it here.
        data-avatar-funnel-target=""
        style={{ viewTransitionName: avatarTransitionName }}
      >
        {avatarMedia ? (
          <AvatarMedia
            media={avatarMedia}
            alt={persona.displayName}
            className="h-full w-full object-contain drop-shadow-[var(--shadow-agent-profile-avatar)]"
            onError={() => setAvatarPreviewFailed(true)}
          />
        ) : (
          <img
            src={fallbackAvatarSrc}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-contain drop-shadow-[var(--shadow-agent-profile-avatar)]"
          />
        )}
      </div>

      {isEditable ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("editor.customizeAvatar")}
            className={AVATAR_CUSTOMIZE_TRIGGER_CLASS}
            onClick={handleOpenAvatarSection}
          />
          <Badge
            variant="secondary"
            className={AVATAR_CUSTOMIZE_LABEL_CLASS}
            aria-hidden="true"
          >
            {t("editor.changeAvatar")}
          </Badge>
        </>
      ) : null}
    </div>
  );

  const pinLabel = isPinnedToHome
    ? t("common:actions.unpinFromHome")
    : t("common:actions.pinToHome");

  const profileActions = (
    <>
      {onStartChat ? (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => onStartChat(persona)}
          leftIcon={<MessageCircle />}
          className={SECONDARY_ACTION_CLASS}
        >
          {t("detail.startChat")}
        </Button>
      ) : null}
      {isEditable ? (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => onEdit(persona)}
          leftIcon={<Pencil />}
          className={SECONDARY_ACTION_CLASS}
        >
          {t("common:actions.edit")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={() => (isPinnedToHome ? unpinFromHome() : void pinToHome())}
        disabled={isPinningToHome}
        leftIcon={<PinIcon fill={isPinnedToHome ? "currentColor" : "none"} />}
        className={SECONDARY_ACTION_CLASS}
      >
        {pinLabel}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("detail.moreActions")}
                className={OVERFLOW_TRIGGER_CLASS}
              >
                <MoreHorizontal className={ACTION_ICON_CLASS} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("detail.moreActions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          variant="raised"
          align="end"
          alignOffset={-4}
          sideOffset={4}
          className={SIDEBAR_RAISED_MENU_CONTENT_CLASS}
        >
          <DropdownMenuItem onSelect={() => onDuplicate(persona)}>
            <Copy className="size-3.5" />
            {t("common:actions.duplicate")}
          </DropdownMenuItem>
          {onShare ? (
            <DropdownMenuItem onSelect={() => onShare(persona)}>
              <Share2 className="size-3.5" />
              {t("share.action")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void onExport(persona)}>
              <Download className="size-3.5" />
              {t("common:actions.export")}
            </DropdownMenuItem>
          )}
          {isDeletable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDelete(persona)}
              >
                <Trash2 className="size-3.5" />
                {t("common:actions.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const profileHeader = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-1 md:-ml-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("view.backToAgents")}
          tooltip={t("view.backToAgents")}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <h1 className="truncate text-[20px] font-normal leading-6 text-surface-agent-profile-fg">
          {persona.displayName}
        </h1>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {profileActions}
      </div>
    </div>
  );

  const avatarCollectionOverlayNode = showAvatarOverlay ? (
    <AvatarCollectionOverlay
      library={avatarLibrary}
      onSelectAvatar={handleSelectOverlayAvatar}
      onClose={handleCloseAvatarOverlay}
    />
  ) : null;

  return (
    <>
      <AgentProfileLayout
        animateSections={false}
        fieldsTransitionName={AGENT_PROFILE_FIELDS_TRANSITION_NAME}
        header={profileHeader}
        identityRail={
          <AgentIdentityRail
            avatar={avatarPreview}
            leadingControl={null}
            metadata={metadata}
            modeControl={null}
          />
        }
      >
        <div className="space-y-6">
          <section
            className="agents-unpaired-enter space-y-3 pt-6"
            style={{ animationDelay: "80ms" }}
            aria-labelledby="agent-instructions"
          >
            <h2 id="agent-instructions" className={CONTEXT_LABEL_CLASS}>
              {t("view.instructions")}
            </h2>
            <div className={INSTRUCTIONS_PANEL_CLASS}>
              <section
                className={INSTRUCTIONS_SCROLL_CLASS}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this nested scroll region.
                tabIndex={0}
                aria-labelledby="agent-instructions"
              >
                <MessageResponse className="min-w-0 pb-4 text-sm leading-relaxed">
                  {persona.systemPrompt || " "}
                </MessageResponse>
              </section>
            </div>
          </section>
        </div>
      </AgentProfileLayout>
      {avatarCollectionOverlayNode}
    </>
  );
}
