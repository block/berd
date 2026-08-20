import { useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { CHAT_ON_CANVAS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { ChatCanvasCard } from "./ChatCanvasCard";
import { IconMessageCircle } from "@tabler/icons-react";
import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { useLocaleFormatting } from "@/shared/i18n";
import { InlineMarkdownText } from "@/shared/ui/inline-markdown-text";
import { cn } from "@/shared/lib/cn";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getSessionId(
  state: Record<string, unknown> | undefined,
): string | null {
  return typeof state?.sessionId === "string" ? state.sessionId : null;
}

function resolveSession(sessions: ChatSession[], id: string | null) {
  return id ? sessions.find((session) => session.id === id) : undefined;
}

export function ChatPinWidget({
  instance,
  onUpdateState,
  shouldIgnoreActivation,
  onSelectSession,
  onCreatePersona,
  onCreateProject,
  onWorkspaceNameRequest,
  isCanvasChatFocused = false,
  onFocusCanvasChat,
  onClearCanvasChatFocus,
  onCanvasChatAvailabilityChange,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const chatOnCanvasEnabled =
    useExperiment(CHAT_ON_CANVAS_EXPERIMENT_ID)?.enabled === true;
  const sessions = useChatSessionStore((state) => state.sessions);
  const sessionId = getSessionId(instance.state);
  const isLoadingSession = useChatStore((state) =>
    sessionId ? (state.loadingSessionIds?.has(sessionId) ?? false) : false,
  );
  const projects = useProjectStore(selectProjects);
  const session = resolveSession(sessions, sessionId);
  const isUnavailable = session?.pinnedLoadState === "failed";
  const isLoading = Boolean(sessionId) && (!session || isLoadingSession);

  const title =
    session && !isUnavailable
      ? session.title.trim() || DEFAULT_CHAT_TITLE
      : t("widgets.chatPin.emptyTitle");
  const project = session?.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined;
  let footerLabel = t("widgets.chatPin.emptyDescription");
  if (isUnavailable) {
    footerLabel = t("widgets.chatPin.unavailableDescription");
  } else if (isLoading) {
    footerLabel = t("widgets.chatPin.loadingDescription");
  } else if (session) {
    footerLabel = [
      project?.name,
      formatRelativeTimeToNow(sessionActivityAt(session)),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const isExpanded =
    chatOnCanvasEnabled && instance.state?.presentation === "expanded";
  // Viewport pausing is a visual-work hint, not a lifecycle boundary. A drag
  // can transiently move this mounted card outside the viewport; availability
  // remains owned by the expanded card/session lifecycle so focus and local
  // transcript/composer state survive that movement.
  const canvasChatAvailable = Boolean(isExpanded && session && !isUnavailable);
  useLayoutEffect(() => {
    onCanvasChatAvailabilityChange?.(instance.id, canvasChatAvailable);
    return () => onCanvasChatAvailabilityChange?.(instance.id, false);
  }, [canvasChatAvailable, instance.id, onCanvasChatAvailabilityChange]);
  useEffect(() => {
    if (!chatOnCanvasEnabled && instance.state?.presentation === "expanded") {
      onUpdateState({ presentation: "collapsed" });
    }
  }, [chatOnCanvasEnabled, instance.state?.presentation, onUpdateState]);
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (!session) return;
    if (chatOnCanvasEnabled) {
      onUpdateState({ presentation: "expanded" });
      return;
    }
    onSelectSession?.(session.id);
  });

  if (isExpanded && session && !isUnavailable) {
    return (
      <ChatCanvasCard
        key={session.id}
        session={session}
        isFocused={isCanvasChatFocused}
        onFocus={onFocusCanvasChat}
        shouldIgnoreActivation={shouldIgnoreActivation}
        onCreatePersona={onCreatePersona}
        onCreateProject={onCreateProject}
        onWorkspaceNameRequest={onWorkspaceNameRequest}
        onCollapse={() => {
          onClearCanvasChatFocus?.();
          onUpdateState({ presentation: "collapsed" });
        }}
        onOpenFullChat={() => onSelectSession?.(session.id)}
      />
    );
  }
  const isCompact = (instance.height ?? 80) <= 96;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t(
        chatOnCanvasEnabled
          ? "widgets.chatPin.expandAria"
          : "widgets.chatPin.openAria",
        { title },
      )}
      className="flex h-full w-full flex-col overflow-hidden rounded-md bg-card text-left text-foreground transition-colors duration-150 hover:bg-muted cursor-pointer"
      style={{
        padding: "clamp(0.75rem, calc(1rem * var(--widget-scale, 1)), 1.75rem)",
      }}
    >
      <span
        className="flex min-w-0 shrink-0 items-start text-foreground"
        style={{
          gap: "clamp(0.4rem, calc(0.5rem * var(--widget-scale, 1)), 0.9rem)",
          fontSize:
            "clamp(0.875rem, calc(0.875rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.625rem)",
          lineHeight:
            "clamp(1.25rem, calc(1.3 * var(--widget-text-scale, var(--widget-scale, 1)) * 0.875rem), 2.25rem)",
        }}
      >
        <IconMessageCircle
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
          style={{
            width:
              "clamp(0.85rem, calc(0.875rem * var(--widget-scale, 1)), 1.5rem)",
            height:
              "clamp(0.85rem, calc(0.875rem * var(--widget-scale, 1)), 1.5rem)",
          }}
        />
        <InlineMarkdownText
          className={cn(
            "min-w-0 pb-px",
            isCompact ? "truncate" : "break-words line-clamp-2",
          )}
        >
          {title}
        </InlineMarkdownText>
      </span>
      <span
        className="mt-1 flex min-w-0 shrink-0 items-center overflow-hidden text-foreground/40"
        style={{
          gap: "clamp(0.3rem, calc(0.375rem * var(--widget-scale, 1)), 0.7rem)",
          fontSize:
            "clamp(0.6875rem, calc(0.625rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.0625rem)",
        }}
      >
        {project ? (
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center"
            style={{
              width:
                "clamp(0.7rem, calc(0.75rem * var(--widget-scale, 1)), 1.25rem)",
              height:
                "clamp(0.7rem, calc(0.75rem * var(--widget-scale, 1)), 1.25rem)",
            }}
          >
            <ProjectIcon
              icon={project.icon}
              color={project.color}
              className="h-full w-full shrink-0"
              imageClassName="h-full w-full shrink-0"
            />
          </span>
        ) : null}
        <span className="min-w-0 truncate">{footerLabel}</span>
      </span>
    </button>
  );
}
