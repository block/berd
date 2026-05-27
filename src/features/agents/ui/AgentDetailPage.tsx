import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Copy,
  Download,
  MousePointer2,
  Pencil,
  PinIcon,
  Trash2,
} from "lucide-react";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { avatarRef, isBundledAvatarRef } from "@/shared/avatars/catalog";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import type { Persona } from "@/shared/types/agents";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaProviderLabel,
  getPersonaSource,
} from "@/features/agents/lib/personaPresentation";
import {
  AGENT_PROFILE_FIELDS_TRANSITION_NAME,
  getAgentAvatarTransitionName,
  runAgentViewTransition,
} from "@/features/agents/lib/agentViewTransitions";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { AgentProfileLayout } from "@/features/agents/ui/AgentProfileLayout";
import { AgentIdentityRail } from "@/features/agents/ui/AgentIdentityRail";
import { useAvatarLibrary } from "@/features/agents/hooks/useAvatarLibrary";
import { AgentAvatarSection } from "@/features/agents/ui/AgentAvatarSection";
import {
  AVATAR_CUSTOMIZE_AFFORDANCE_CLASS,
  AVATAR_CUSTOMIZE_SURFACE_CLASS,
  AVATAR_CUSTOMIZE_TRIGGER_CLASS,
  updateAvatarCustomizePosition,
} from "@/features/agents/ui/avatarCustomizeMotion";

interface AgentDetailPageProps {
  persona: Persona;
  onBack: () => void;
  onEdit: (persona: Persona) => void;
  onDuplicate: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onExport: (persona: Persona) => void;
  onAvatarUpdate: (persona: Persona, avatar: string | null) => Promise<void>;
}

const CONTEXT_LABEL_CLASS =
  "text-[10px] leading-3 font-normal text-surface-agent-profile-fg-muted";
const ACTION_BUTTON_CLASS =
  "size-9 rounded-full bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover";
const ACTION_ICON_CLASS = "size-3.5";
const AVATAR_FIELD_INPUT_CLASS =
  "h-[42px] rounded-full border-0 bg-surface-agent-profile-control-bg px-4 text-[14px] leading-[15px] text-surface-agent-profile-fg shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-surface-agent-profile-fg-placeholder hover:shadow-agent-profile-input-hover focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-agent-profile-input-focus";
const AVATAR_FIELD_LABEL_CLASS =
  "text-[10px] leading-3 font-normal text-surface-agent-profile-fg-muted";
const INSTRUCTIONS_PANEL_CLASS =
  "min-h-[24rem] w-full overflow-y-auto rounded-[10px] px-3 py-2 text-[16px] leading-8 text-surface-agent-profile-fg lg:min-h-[29rem]";

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
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
  onAvatarUpdate,
}: AgentDetailPageProps) {
  const { t } = useTranslation(["agents", "common"]);
  const acpProviders = useAgentStore((s) => s.providers);
  const personaSource = getPersonaSource(persona);
  const isEditable = canEditPersona(persona);
  const isDeletable = canDeletePersona(persona);
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
  } = usePinToHomeWidget({ kind: "agent", id: persona.id });
  const personaAvatarValue = normalizeAvatarUrl(persona.avatar) ?? "";
  const [avatarValue, setAvatarValue] = useState(personaAvatarValue);
  const [avatarPreviewFailed, setAvatarPreviewFailed] = useState(false);
  const [avatarSavePending, setAvatarSavePending] = useState(false);
  const [showAvatarSection, setShowAvatarSection] = useState(false);
  const previousPersonaIdRef = useRef(persona.id);
  const avatarLibrary = useAvatarLibrary(isEditable);
  const trimmedAvatarValue = avatarValue.trim();
  const normalizedAvatarValue = normalizeAvatarUrl(trimmedAvatarValue);
  const customAvatarUrlValue = isBundledAvatarRef(trimmedAvatarValue)
    ? ""
    : avatarValue;
  const avatarUrlError =
    trimmedAvatarValue.length > 0 && !normalizedAvatarValue
      ? t("editor.avatarUrlInvalid")
      : null;
  const avatarMedia = useAvatarMedia(normalizedAvatarValue ?? null);
  const selectedBundledAvatarRef =
    normalizedAvatarValue && isBundledAvatarRef(normalizedAvatarValue)
      ? normalizedAvatarValue
      : null;
  const canSaveCustomAvatar =
    Boolean(normalizedAvatarValue) &&
    !isBundledAvatarRef(normalizedAvatarValue ?? "") &&
    normalizedAvatarValue !== personaAvatarValue &&
    !avatarSavePending;
  const sourceLabel =
    personaSource === "builtin"
      ? t("common:labels.builtIn")
      : t("card.fileBacked");
  const providerLabel = getPersonaProviderLabel(
    persona.provider,
    acpProviders,
    t("common:labels.none"),
  );
  const modelLabel = persona.model || t("common:labels.none");
  const createdLabel = persona.createdAt ? formatDate(persona.createdAt) : null;
  const updatedLabel = persona.updatedAt ? formatDate(persona.updatedAt) : null;
  const avatarTransitionName = getAgentAvatarTransitionName(persona.id);
  const fallbackAvatarSrc = resolveAgentIcon(persona.id);
  const metadata = [
    { label: t("view.source"), value: sourceLabel },
    { label: t("editor.provider"), value: providerLabel },
    { label: t("editor.model"), value: modelLabel },
    createdLabel ? { label: t("view.created"), value: createdLabel } : null,
    updatedLabel ? { label: t("view.updated"), value: updatedLabel } : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  useEffect(() => {
    setAvatarValue(personaAvatarValue);
    setAvatarPreviewFailed(false);
  }, [personaAvatarValue]);

  useEffect(() => {
    if (previousPersonaIdRef.current !== persona.id) {
      previousPersonaIdRef.current = persona.id;
      setShowAvatarSection(false);
    }
  }, [persona.id]);

  const handleOpenAvatarSection = useCallback(() => {
    runAgentViewTransition(() => setShowAvatarSection(true));
  }, []);

  const handleCloseAvatarSection = useCallback(() => {
    runAgentViewTransition(() => setShowAvatarSection(false));
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
      } catch {
        setAvatarValue(personaAvatarValue);
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

  const handleClearAvatar = useCallback(() => {
    setAvatarValue("");
    void commitAvatar(null);
  }, [commitAvatar]);

  const handleAvatarUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setAvatarValue(event.target.value);
      setAvatarPreviewFailed(false);
    },
    [],
  );

  const handleSaveCustomAvatar = useCallback(() => {
    if (!normalizedAvatarValue || avatarUrlError) {
      return;
    }

    void commitAvatar(normalizedAvatarValue);
  }, [avatarUrlError, commitAvatar, normalizedAvatarValue]);

  const handleSelectAvatar = useCallback(
    (avatarId: string) => {
      const nextAvatar = avatarRef(avatarId);
      setAvatarValue(nextAvatar);
      setAvatarPreviewFailed(false);
      void commitAvatar(nextAvatar);
    },
    [commitAvatar],
  );

  const avatarPreview = (
    <div
      className={AVATAR_CUSTOMIZE_SURFACE_CLASS}
      onPointerEnter={updateAvatarCustomizePosition}
      onPointerMove={updateAvatarCustomizePosition}
    >
      <div
        className="h-full w-full"
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

      {isEditable && !showAvatarSection ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("editor.customizeAvatar")}
            title={t("editor.customizeAvatar")}
            className={AVATAR_CUSTOMIZE_TRIGGER_CLASS}
            onClick={handleOpenAvatarSection}
          />
          <div className={AVATAR_CUSTOMIZE_AFFORDANCE_CLASS} aria-hidden="true">
            <MousePointer2 className="size-3.5" />
            {t("editor.customizeAvatar")}
          </div>
        </>
      ) : null}
    </div>
  );

  const profileActions = (
    <>
      {isEditable ? (
        <Button
          type="button"
          size="icon"
          aria-label={t("common:actions.edit")}
          title={t("common:actions.edit")}
          onClick={() => onEdit(persona)}
          className="size-9 rounded-full !bg-surface-agent-profile-fg !text-surface-agent-profile-control-bg hover:!bg-surface-agent-profile-action-bg-hover"
        >
          <Pencil className={ACTION_ICON_CLASS} />
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={
          isPinnedToHome
            ? t("common:actions.pinnedToHome")
            : t("common:actions.pinToHome")
        }
        title={
          isPinnedToHome
            ? t("common:actions.pinnedToHome")
            : t("common:actions.pinToHome")
        }
        onClick={() => void pinToHome()}
        disabled={isPinnedToHome || isPinningToHome}
        className={ACTION_BUTTON_CLASS}
      >
        <PinIcon className={ACTION_ICON_CLASS} />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t("common:actions.duplicate")}
        title={t("common:actions.duplicate")}
        onClick={() => onDuplicate(persona)}
        className={ACTION_BUTTON_CLASS}
      >
        <Copy className={ACTION_ICON_CLASS} />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t("common:actions.export")}
        title={t("common:actions.export")}
        onClick={() => onExport(persona)}
        className={ACTION_BUTTON_CLASS}
      >
        <Download className={ACTION_ICON_CLASS} />
      </Button>
      {isDeletable ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("common:actions.delete")}
          title={t("common:actions.delete")}
          onClick={() => onDelete(persona)}
          className="size-9 rounded-full bg-surface-agent-profile-control-bg text-destructive shadow-none hover:bg-surface-agent-profile-control-bg-hover hover:text-destructive"
        >
          <Trash2 className={ACTION_ICON_CLASS} />
        </Button>
      ) : null}
    </>
  );

  const backToProfileControl = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCloseAvatarSection}
      className="h-9 rounded-full bg-surface-agent-profile-control-bg px-3 text-sm text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover"
    >
      <ArrowLeft className="size-3.5" />
      {t("editor.avatarBackToProfile")}
    </Button>
  );

  const backToAgentsControl = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onBack}
      className="h-9 rounded-full bg-surface-agent-profile-control-bg px-3 text-sm text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover"
    >
      <ArrowLeft className="size-3.5" />
      {t("view.backToAgents")}
    </Button>
  );

  return (
    <AgentProfileLayout
      animateSections={false}
      fieldsTransitionName={AGENT_PROFILE_FIELDS_TRANSITION_NAME}
      identityRail={
        <AgentIdentityRail
          avatar={avatarPreview}
          title={persona.displayName}
          leadingControl={showAvatarSection ? null : backToAgentsControl}
          metadata={showAvatarSection ? [] : metadata}
          actions={showAvatarSection ? null : profileActions}
          modeControl={showAvatarSection ? backToProfileControl : null}
        />
      }
    >
      {showAvatarSection ? (
        <AgentAvatarSection
          avatarPreviewFailed={avatarPreviewFailed}
          avatarPickerDisabled={avatarSavePending}
          avatarUrlError={avatarUrlError}
          avatarUrlInputId="agent-detail-avatar-url"
          canSaveCustomAvatar={canSaveCustomAvatar}
          clearDisabled={avatarSavePending}
          customAvatarUrlValue={customAvatarUrlValue}
          fieldGroupClassName="space-y-2"
          fieldInputClassName={AVATAR_FIELD_INPUT_CLASS}
          fieldLabelClassName={AVATAR_FIELD_LABEL_CLASS}
          library={avatarLibrary}
          onAvatarUrlChange={handleAvatarUrlChange}
          onClearAvatar={handleClearAvatar}
          onPreviewError={() => setAvatarPreviewFailed(true)}
          onSaveCustomAvatar={handleSaveCustomAvatar}
          onSelectAvatar={handleSelectAvatar}
          selectedAvatarRef={selectedBundledAvatarRef}
          showClearAvatar={trimmedAvatarValue.length > 0}
          title={t("editor.customizeAvatar")}
        />
      ) : (
        <div className="space-y-6">
          <section
            className="agents-unpaired-enter space-y-5 border-y border-surface-agent-profile-border py-6"
            style={{ animationDelay: "80ms" }}
            aria-labelledby="agent-instructions"
          >
            <div className="flex items-end justify-between gap-3">
              <h2 id="agent-instructions" className={CONTEXT_LABEL_CLASS}>
                {t("view.instructions")}
              </h2>
              <span className="shrink-0 text-[10px] leading-3 text-surface-agent-profile-fg-faint">
                {t("common:labels.characterCount", {
                  count: persona.systemPrompt.length,
                })}
              </span>
            </div>
            <div className={INSTRUCTIONS_PANEL_CLASS}>
              <MessageResponse className="min-w-0 max-w-[68ch] text-[16px] leading-8">
                {persona.systemPrompt || " "}
              </MessageResponse>
            </div>
          </section>
        </div>
      )}
    </AgentProfileLayout>
  );
}
