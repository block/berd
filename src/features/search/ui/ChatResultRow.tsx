import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { SessionSearchDisplayResult } from "@/features/sessions/lib/buildSessionSearchResults";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { MessageSquare } from "lucide-react";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { ResultRow } from "./ResultRow";

interface ChatResultRowProps {
  id?: string;
  result: SessionSearchDisplayResult;
  defaultTitle: string;
  ariaLabel: string;
  query?: string;
  project?: {
    id: string;
    name: string;
    icon?: string | null;
    color?: string | null;
  };
  formatRelativeTimeToNow: (value: Date | string | number) => string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (sessionId: string, messageId?: string) => void;
}

export function ChatResultRow({
  id,
  result,
  defaultTitle,
  ariaLabel,
  query,
  project,
  formatRelativeTimeToNow,
  isActive,
  onActive,
  onSelect,
}: ChatResultRowProps) {
  const session: ChatSession = result.session;
  const title = getDisplaySessionTitle(session.title, defaultTitle);

  return (
    <ResultRow
      id={id}
      title={title}
      meta={
        project ? (
          <span className="flex items-center gap-1.5">
            <ProjectIcon
              icon={project.icon}
              color={project.color}
              projectId={project.id}
              className="size-3.5"
              imageClassName="size-3.5"
            />
            <span>{project.name}</span>
          </span>
        ) : (
          formatRelativeTimeToNow(sessionActivityAt(session))
        )
      }
      icon={<MessageSquare aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(session.id, result.messageId)}
    />
  );
}
