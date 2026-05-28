import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconMessageCircle } from "@tabler/icons-react";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  getVisibleSessions,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
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
  return sessions.find((session) => session.id === id) ?? sessions[0];
}

export function ChatPinWidget({
  instance,
  shouldIgnoreActivation,
  onSelectSession,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const sessions = useChatSessionStore((state) => state.sessions);
  const messagesBySession = useChatStore((state) => state.messagesBySession);
  const projects = useProjectStore(selectProjects);

  const visibleSessions = useMemo(
    () =>
      getVisibleSessions(sessions, messagesBySession).filter(
        (s) => !s.archivedAt,
      ),
    [messagesBySession, sessions],
  );

  const session = resolveSession(visibleSessions, getSessionId(instance.state));
  const title = session
    ? session.title.trim() || DEFAULT_CHAT_TITLE
    : t("widgets.chatPin.emptyTitle");
  const project = session?.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined;
  const footerLabel = session
    ? [project?.name, formatRelativeTimeToNow(session.updatedAt)]
        .filter(Boolean)
        .join(" · ")
    : t("widgets.chatPin.emptyDescription");
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (session) onSelectSession?.(session.id);
  });
  const isCompact = (instance.height ?? 80) <= 96;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t("widgets.chatPin.openAria", { title })}
      className="flex h-full w-full flex-col overflow-hidden rounded-card-chat bg-card text-left text-foreground transition-colors duration-150 hover:bg-muted cursor-pointer"
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
            "clamp(1.05rem, calc(1.125rem * var(--widget-text-scale, var(--widget-scale, 1))), 2rem)",
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
            "min-w-0",
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
