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

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t("widgets.chatPin.openAria", { title })}
      className="flex h-full w-full flex-col rounded-card-chat bg-card p-4 text-left text-foreground transition-colors duration-150 hover:bg-muted cursor-pointer"
    >
      <span className="flex min-w-0 items-start gap-2 text-sm leading-[18px] text-foreground">
        <IconMessageCircle
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 break-words line-clamp-2">{title}</span>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[10px] text-foreground/40">
        {project ? (
          <ProjectIcon
            icon={project.icon}
            className="size-3 shrink-0"
            imageClassName="size-3 shrink-0"
          />
        ) : null}
        <span className="min-w-0 break-words line-clamp-2">{footerLabel}</span>
      </span>
    </button>
  );
}
