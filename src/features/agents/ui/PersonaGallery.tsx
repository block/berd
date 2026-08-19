import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconArrowDownToArc, IconPlus } from "@tabler/icons-react";
import { selectAvatarImageUrl } from "@/shared/api/artifacts";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { AgentTileButton } from "@/shared/ui/agent-tile-button";
import { AgentAddChoiceButton } from "@/shared/ui/agent-add-choice-button";
import { AgentImportSecondaryButton } from "@/shared/ui/agent-import-secondary-button";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Badge } from "@/shared/ui/badge";
import { Skeleton } from "@/shared/ui/skeleton";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Persona } from "@/shared/types/agents";
import { PersonaCard } from "@/features/agents/ui/PersonaCard";
import { useArtifacts } from "@/shared/hooks/useArtifacts";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { usePersonaSource } from "@/features/agents/hooks/usePersonaSource";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import {
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
} from "@/features/agents/lib/agentBuilderIdentity";

// Blue jello gloopy shown oversized in the gallery empty state, per the
// onboarding Figma. Resolved from the startup artifacts catalog.
const EMPTY_STATE_GLOOPY_AVATAR_ID = "gloopies-14";

const GALLERY_CARD_STAGGER_MS = 40;
const MAX_STAGGERED_CARDS = 6;

function galleryCardDelay(index: number): string {
  return `${Math.min(index, MAX_STAGGERED_CARDS) * GALLERY_CARD_STAGGER_MS}ms`;
}

interface PersonaGalleryProps {
  personas: Persona[];
  draftSessions?: ChatSession[];
  activePersonaId?: string;
  onSelectPersona: (persona: Persona) => void;
  onStartChatPersona?: (persona: Persona) => void;
  onEditPersona: (persona: Persona) => void;
  onDuplicatePersona: (persona: Persona) => void;
  onDeletePersona: (persona: Persona) => void;

  onExportPersona?: (persona: Persona) => void | Promise<void>;
  onSharePersona?: (persona: Persona) => void;

  onCreatePersona: () => void;
  onImportAgentImage?: () => void;
  onContinueDraft?: (sessionId: string) => void;
  onDeleteDraft?: (sessionId: string) => void;
  onImportFile?: (fileBytes: Uint8Array, fileName: string) => void;
  validateImportFile?: (
    file: Pick<File, "name" | "type" | "size">,
  ) => string | null;
  onImportError?: (message: string) => void;
  maxImportBytes?: number;
  importTooLargeMessage?: string;
  isLoading?: boolean;
}

function draftTitle(session: ChatSession, sourceName?: string): string {
  const name = sourceName?.trim();
  if (name && !isPlaceholderAgentName(name)) return name;

  const title = session.title.trim();
  return title.length > 0 ? title : "Untitled agent draft";
}

function draftDescription(content?: string): string | null {
  const trimmed = content?.trim();
  if (!trimmed || trimmed === PLACEHOLDER_AGENT_BODY) return null;
  return trimmed;
}

function draftAvatar(sourceAvatar: unknown): string | null {
  return typeof sourceAvatar === "string" ? sourceAvatar : null;
}

function PersonaDraftCard({
  session,
  onContinue,
  onDelete,
}: {
  session: ChatSession;
  onContinue?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const [readyAnimatedAvatarSrc, setReadyAnimatedAvatarSrc] = useState<
    string | null
  >(null);
  const { data } = usePersonaSource(session.targetAgentPath ?? null, {
    builderSessionId: session.id,
  });
  const title = draftTitle(session, data?.name);
  const description =
    draftDescription(data?.content) ?? t("gallery.draftDescription");
  const avatar = draftAvatar(data?.properties?.avatar);
  const avatarMedia = useAvatarMedia(avatar);
  const staticAvatarSrc =
    avatarMedia?.posterSrc ??
    (avatarMedia?.mediaType === "image" ? avatarMedia.src : undefined);
  const animatedAvatarReady =
    avatarMedia?.mediaType === "video" &&
    readyAnimatedAvatarSrc === avatarMedia.src;
  const fallbackIconSrc = resolveAgentIcon(
    session.targetAgentPath ?? session.id,
  );

  const hoverActionsOverlay = (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-6 z-10 flex items-center justify-center gap-2 opacity-0",
        "transition-opacity duration-200",
        "group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <AgentTileButton
        type="button"
        size="sm"
        onClick={() => onContinue?.(session.id)}
        aria-label={t("gallery.continueDraftAria", { name: title })}
        className="pointer-events-auto"
      >
        {t("gallery.continueDraft")}
      </AgentTileButton>
      <Button
        type="button"
        variant="subtle"
        size="sm"
        destructive
        onClick={() => onDelete?.(session.id)}
        aria-label={t("gallery.deleteDraftAria", { name: title })}
        className="pointer-events-auto"
      >
        {t("gallery.deleteDraft")}
      </Button>
    </div>
  );

  return (
    <div className="group relative flex w-full flex-col gap-4 rounded-md bg-transparent p-2 transition-colors duration-200">
      <div className="relative">
        <div className="relative aspect-square w-full overflow-hidden rounded-sm">
          <img
            alt={staticAvatarSrc ? title : ""}
            aria-hidden={staticAvatarSrc ? undefined : true}
            src={staticAvatarSrc ?? fallbackIconSrc}
            loading="lazy"
            decoding="async"
            className={cn(
              "pointer-events-none absolute inset-0 size-full object-contain opacity-55 saturate-[0.8] transition-[transform,opacity] duration-300",
              "group-hover:scale-[1.02] group-hover:opacity-70",
              animatedAvatarReady && "opacity-0",
            )}
          />
          {avatarMedia?.mediaType === "video" ? (
            <AvatarMedia
              media={avatarMedia}
              alt=""
              loadingStrategy="eager"
              poster={staticAvatarSrc}
              onReady={() => setReadyAnimatedAvatarSrc(avatarMedia.src)}
              className={cn(
                "pointer-events-none absolute inset-0 object-contain opacity-0 saturate-[0.8] transition-[transform,opacity] duration-200",
                "group-hover:scale-[1.02]",
                animatedAvatarReady
                  ? "opacity-55 group-hover:opacity-70"
                  : null,
              )}
            />
          ) : null}
        </div>
        {hoverActionsOverlay}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-base font-normal leading-5 text-foreground">
              {title}
            </span>
            <Badge
              variant="secondary"
              className="rounded-full text-[11px] uppercase tracking-[0.08em]"
            >
              {t("gallery.draft")}
            </Badge>
          </span>
          <span aria-hidden="true" className="size-7 shrink-0" />
        </div>
        <p className="line-clamp-3 max-w-[28ch] text-xs font-normal leading-4 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-4 p-2">
      <Skeleton className="aspect-square w-full rounded-sm" />
      <div className="space-y-3 px-1">
        <Skeleton className="h-px w-full rounded-none" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

export function PersonaGallery({
  personas,
  draftSessions = [],
  activePersonaId,
  onSelectPersona,
  onStartChatPersona,
  onEditPersona,
  onDuplicatePersona,
  onDeletePersona,
  onExportPersona,
  onSharePersona,
  onCreatePersona,
  onImportAgentImage,
  onContinueDraft,
  onDeleteDraft,
  onImportFile,
  validateImportFile,
  onImportError,
  maxImportBytes,
  importTooLargeMessage,
  isLoading = false,
}: PersonaGalleryProps) {
  const { t } = useTranslation("agents");
  const shouldReduceMotion = useReducedMotion();
  const [showAddActions, setShowAddActions] = useState(false);
  const addTileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddActions) return;
    const collapseOnOutsidePointer = (event: PointerEvent) => {
      if (!addTileRef.current?.contains(event.target as Node)) {
        setShowAddActions(false);
      }
    };
    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAddActions(false);
    };
    document.addEventListener("pointerdown", collapseOnOutsidePointer);
    document.addEventListener("keydown", collapseOnEscape);
    return () => {
      document.removeEventListener("pointerdown", collapseOnOutsidePointer);
      document.removeEventListener("keydown", collapseOnEscape);
    };
  }, [showAddActions]);
  const emptyGloopyQuery = useArtifacts({
    enabled: !isLoading && personas.length === 0,
    select: (artifacts) =>
      selectAvatarImageUrl(artifacts, EMPTY_STATE_GLOOPY_AVATAR_ID),
  });
  const emptyGloopyUrl = emptyGloopyQuery.data;
  const { fileInputRef, isDragOver, dropHandlers, handleFileChange } =
    useFileImportZone({
      onImportFile: onImportFile ?? (() => {}),
      validateFile: validateImportFile,
      onImportError,
      maxBytes: maxImportBytes,
      fileTooLargeMessage: importTooLargeMessage,
    });

  const sorted = useMemo(() => {
    const builtins = personas
      .filter((p) => p.isBuiltin)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const custom = personas
      .filter((p) => !p.isBuiltin)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return [...builtins, ...custom];
  }, [personas]);

  // Cards stay a fixed size when the sidebar collapses; `justify-evenly`
  // distributes the extra width between and around them. Mirrors SkillsGrid.
  const gridClass = cn(
    "grid gap-x-8 gap-y-10",
    "grid-cols-2 sm:grid-cols-3",
    "xl:grid-cols-[repeat(4,minmax(0,16rem))] xl:justify-evenly",
  );

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label={t("gallery.loading")}
        className={gridClass}
      >
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (personas.length === 0 && draftSessions.length === 0) {
    return (
      <div
        {...dropHandlers}
        className={cn(
          "@container min-h-[calc(100dvh-12rem)]",
          isDragOver && "bg-muted/30",
        )}
      >
        <div className="flex h-full min-h-[inherit] flex-col items-center justify-center gap-x-10 gap-y-8 px-6 py-12 @2xl:flex-row">
          {emptyGloopyUrl ? (
            // Stacked above the copy at a fixed h-64 on narrow panels; beside
            // it on @2xl+, growing fluidly between 240px and 760px wide.
            <img
              src={emptyGloopyUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="pointer-events-none h-64 w-auto self-center select-none @2xl:h-auto @2xl:min-w-[240px] @2xl:max-w-[760px] @2xl:flex-1 @2xl:basis-0"
            />
          ) : null}
          <div className="flex w-full max-w-[359px] shrink-0 flex-col items-start text-left">
            <div className="space-y-1">
              <h2
                id="personas-heading"
                className="font-display text-base font-normal leading-5 text-surface-agent-profile-fg"
              >
                {t("gallery.empty.aboutTitle")}
              </h2>
              <p className="text-base leading-5 text-surface-agent-profile-fg-subtle">
                {t("gallery.empty.aboutDescription")}
              </p>
            </div>

            <div className="mt-[29px] space-y-1">
              <h3 className="font-display text-base font-normal leading-5 text-surface-agent-profile-fg">
                {t("gallery.empty.valueTitle")}
              </h3>
              <p className="text-base leading-5 text-surface-agent-profile-fg-subtle">
                {t("gallery.empty.valueDescription")}
              </p>
            </div>

            <div className="mt-[35px] flex w-full flex-col gap-2">
              <Button
                type="button"
                aria-label={t("gallery.createAria")}
                onClick={onCreatePersona}
                className="w-full text-sm"
              >
                {t("gallery.empty.createFirst")}
              </Button>
              <AgentImportSecondaryButton
                type="button"
                onClick={onImportAgentImage}
                className="w-full text-sm"
              >
                {t("gallery.importViaImage")}
              </AgentImportSecondaryButton>
            </div>
          </div>
        </div>
        {onImportFile && (
          <input
            ref={fileInputRef}
            type="file"
            accept=".agent.png,.persona.md,.json,image/png,text/markdown,text/plain,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        )}
      </div>
    );
  }

  return (
    <div {...dropHandlers} className={gridClass}>
      <div
        ref={addTileRef}
        className="agents-gallery-card-enter flex min-h-40 w-full items-center justify-center p-4"
      >
        <AnimatePresence mode="wait" initial={false}>
          {showAddActions ? (
            <motion.div
              key="add-actions"
              initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={
                shouldReduceMotion ? undefined : { opacity: 0, scale: 0.92 }
              }
              transition={{
                duration: shouldReduceMotion ? 0 : 0.18,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="flex flex-col items-stretch gap-2"
            >
              {onImportAgentImage ? (
                <AgentAddChoiceButton
                  type="button"
                  onClick={() => {
                    setShowAddActions(false);
                    onImportAgentImage();
                  }}
                >
                  <IconArrowDownToArc className="size-3.5" />
                  {t("gallery.importViaImage")}
                </AgentAddChoiceButton>
              ) : null}
              <AgentAddChoiceButton
                type="button"
                onClick={() => {
                  setShowAddActions(false);
                  onCreatePersona();
                }}
              >
                <IconPlus />
                {t("gallery.createNew")}
              </AgentAddChoiceButton>
            </motion.div>
          ) : (
            <motion.button
              key="add-trigger"
              type="button"
              initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.82 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={
                shouldReduceMotion ? undefined : { opacity: 0, scale: 0.82 }
              }
              transition={{
                duration: shouldReduceMotion ? 0 : 0.2,
                ease: [0.22, 1, 0.36, 1],
              }}
              aria-label={t("gallery.addAgentAria")}
              onClick={() => setShowAddActions(true)}
              className={cn(
                "group flex size-full min-h-32 items-center justify-center rounded-md bg-card/70 p-4 dark:bg-background/25",
                "text-muted-foreground transition-colors duration-200",
                "hover:bg-card hover:text-foreground dark:hover:bg-background/45",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <IconPlus className="size-8 stroke-[1.25]" aria-hidden="true" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      {sorted.map((persona, index) => (
        <div
          key={persona.id}
          className="agents-gallery-card-enter"
          style={{
            animationDelay: galleryCardDelay(index + 1),
          }}
        >
          <PersonaCard
            persona={persona}
            isActive={persona.id === activePersonaId}
            onSelect={onSelectPersona}
            onStartChat={onStartChatPersona}
            onEdit={onEditPersona}
            onDuplicate={onDuplicatePersona}
            onDelete={onDeletePersona}
            onExport={onExportPersona}
            onShare={onSharePersona}
          />
        </div>
      ))}
      {draftSessions.map((session, index) => (
        <div
          key={`draft:${session.id}`}
          className="agents-gallery-card-enter"
          style={{
            animationDelay: galleryCardDelay(sorted.length + index + 1),
          }}
        >
          <PersonaDraftCard
            session={session}
            onContinue={onContinueDraft}
            onDelete={onDeleteDraft}
          />
        </div>
      ))}
      {onImportFile && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".agent.png,.persona.md,.json,image/png,text/markdown,text/plain,application/json"
          className="hidden"
          onChange={handleFileChange}
        />
      )}
    </div>
  );
}
