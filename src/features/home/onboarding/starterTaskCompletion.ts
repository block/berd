import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { Message } from "@/shared/types/messages";
import type { StarterTaskCompletionState } from "./starterTasks";

export interface StarterTaskCompletionInput {
  providerReady: boolean;
  sessionsHydrated: boolean;
  sessions: ChatSession[];
  messagesBySession: Record<string, Message[]>;
  projectsFetched: boolean;
  projects: ProjectInfo[];
}

export function deriveStarterTaskCompletion({
  providerReady,
  sessionsHydrated,
  sessions,
  messagesBySession,
  projectsFetched,
  projects,
}: StarterTaskCompletionInput): StarterTaskCompletionState {
  const startedChat =
    sessionsHydrated &&
    sessions.some(
      (session) =>
        !session.archivedAt &&
        session.intent !== "build-agent" &&
        (session.messageCount > 0 ||
          (messagesBySession[session.id]?.some(
            (message) =>
              message.role === "user" &&
              message.metadata?.userVisible !== false,
          ) ??
            false)),
    );

  return {
    "connect-provider": providerReady,
    "start-chat": startedChat,
    "create-project":
      projectsFetched && projects.some((project) => !project.archivedAt),
    "add-widget": false,
  };
}
