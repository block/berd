import { IconArrowsMinimize, IconExternalLink } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChatTranscriptReadModel } from "@/features/chat/hooks/useChatTranscriptReadModel";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { ChatTranscriptSurface } from "@/features/chat/ui/ChatTranscriptSurface";
import { LoadingBerd } from "@/features/chat/ui/LoadingBerd";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

interface ChatCanvasCardProps {
  session: ChatSession;
  onCollapse: () => void;
  onOpenFullChat: () => void;
}

export function ChatCanvasCard({
  session,
  onCollapse,
  onOpenFullChat,
}: ChatCanvasCardProps) {
  const { t } = useTranslation(["home", "chat"]);
  const transcript = useChatTranscriptReadModel(session.id);
  const { chatState, streamingMessageId } = transcript.runtime;
  const title = session.title.trim() || DEFAULT_CHAT_TITLE;
  const showActivity =
    chatState === "thinking" ||
    chatState === "streaming" ||
    chatState === "waiting" ||
    chatState === "compacting";

  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md bg-card text-foreground shadow-mini"
    >
      <header className="flex h-11 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing">
        {showActivity ? <ActiveChatBerdIndicator size={14} /> : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <div
          className="flex shrink-0 items-center gap-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("home:widgets.chatPin.collapseAria", { title })}
            title={t("home:widgets.chatPin.collapseAria", { title })}
            onClick={onCollapse}
          >
            <IconArrowsMinimize aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("home:widgets.chatPin.openFullAria", { title })}
            title={t("home:widgets.chatPin.openFullAria", { title })}
            onClick={onOpenFullChat}
          >
            <IconExternalLink aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div
        className="relative flex min-h-0 flex-1 flex-col select-text touch-pan-y"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ChatTranscriptSurface
          sessionId={session.id}
          messages={transcript.messages}
          streamingMessageId={streamingMessageId}
          isLoadingHistory={transcript.isLoadingHistory}
          selectedPersona={transcript.selectedPersona}
          sessionCwd={transcript.sessionArtifactCwd}
          footerStatus={
            showActivity && !transcript.isLoadingHistory ? (
              <div
                className={cn(
                  "flex h-8 items-center gap-2 rounded-full bg-surface-chat-responding-pill-bg px-3 text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]",
                  "[--shimmer-ink:var(--color-surface-chat-responding-pill-fg)]",
                )}
              >
                <ActiveChatBerdIndicator size={14} />
                <LoadingBerd
                  chatState={
                    chatState as
                      | "thinking"
                      | "streaming"
                      | "waiting"
                      | "compacting"
                  }
                  className="mb-0 px-0"
                  motionPreset="responding"
                />
              </div>
            ) : null
          }
        />
      </div>
    </section>
  );
}
