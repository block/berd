import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatTranscriptReadModel } from "@/features/chat/hooks/useChatTranscriptReadModel";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";
import {
  ConversationComposerCapability,
  useConversationComposerBinding,
} from "@/features/chat/capabilities/ConversationComposerCapability";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { projectRecentConversationExchanges } from "@/features/chat/lib/boundedConversationProjection";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { ChatTranscriptSurface } from "@/features/chat/ui/ChatTranscriptSurface";
import { LoadingBerd } from "@/features/chat/ui/LoadingBerd";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

function CanvasCardComposer({
  session,
  onCreatePersona,
  onCreateProject,
  onWorkspaceNameRequest,
}: {
  session: ChatSession;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
}) {
  const binding = useConversationComposerBinding({
    target: {
      kind: "existingSession",
      sessionId: session.id,
      sessionSnapshot: session,
      readOnlyWhenOpenInAnotherWindow: true,
    },
    onCreatePersonaRequested: onCreatePersona,
    onWorkspaceNameRequest,
  });

  return (
    <ConversationComposerCapability
      binding={binding}
      renderingPolicy={{
        presentation: {
          surface: "bare",
          innerBareSurface: true,
          providerColumnMode: "gated",
        },
        allowedInteractions: {
          // Canvas composers are route-neutral: recovery-capable target controls
          // stay in full chat, while drafting, attachments, queueing, stopping,
          // and steering remain available here.
          controls: {
            agentModelPicker: false,
            autoFocus: false,
            personaPicker: false,
            projectPicker: false,
            voice: false,
          },
        },
      }}
      onCreateProject={onCreateProject}
    />
  );
}

interface ChatCanvasCardProps {
  session: ChatSession;
  isFocused: boolean;
  onFocus?: () => void;
  shouldIgnoreActivation?: () => boolean;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCollapse: () => void;
  onOpenFullChat: () => void;
}

export function ChatCanvasCard({
  session,
  isFocused,
  onFocus,
  shouldIgnoreActivation = () => false,
  onCreatePersona,
  onCreateProject,
  onWorkspaceNameRequest,
  onCollapse,
  onOpenFullChat,
}: ChatCanvasCardProps) {
  const { t } = useTranslation(["home", "chat"]);
  const transcript = useChatTranscriptReadModel(session.id);
  const projects = useProjectStore(selectProjects);
  const project = session.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined;
  const { chatState, streamingMessageId } = transcript.runtime;
  const title = session.title.trim() || DEFAULT_CHAT_TITLE;
  const showActivity =
    chatState === "thinking" ||
    chatState === "streaming" ||
    chatState === "waiting" ||
    chatState === "compacting";
  const composerPointerActivationRef = useRef(false);
  const boundedTranscript = useMemo(
    () => projectRecentConversationExchanges(transcript.messages),
    [transcript.messages],
  );

  const focusAndMarkRead = () => {
    if (shouldIgnoreActivation()) {
      return;
    }
    onFocus?.();
    useChatStore.getState().markSessionRead(session.id);
  };

  const activateComposerFromPointer = () => {
    composerPointerActivationRef.current = true;
    queueMicrotask(() => {
      composerPointerActivationRef.current = false;
    });
    focusAndMarkRead();
  };

  const activateComposerFromFocus = () => {
    if (composerPointerActivationRef.current) {
      composerPointerActivationRef.current = false;
      return;
    }
    focusAndMarkRead();
  };

  return (
    <section
      aria-label={title}
      data-canvas-chat-focused={isFocused ? "true" : "false"}
      className="flex h-full min-h-0 w-full cursor-default flex-col overflow-hidden rounded-md bg-card text-foreground shadow-mini [--chat-composer-max-width:100%] [--chat-transcript-container-max-width:100%] [--chat-transcript-inline-padding:0.75rem] [--chat-transcript-max-width:100%] [--chat-user-message-max-width:85%]"
    >
      <header
        data-home-widget-drag-handle="true"
        className="flex h-11 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing"
      >
        {showActivity ? <ActiveChatBerdIndicator size={14} /> : null}
        {project ? (
          <ProjectIcon
            icon={project.icon}
            color={project.color}
            projectId={project.id}
            className="size-4 shrink-0"
            imageClassName="size-4 shrink-0"
          />
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <div
          className="flex shrink-0 items-center gap-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            variant="subtle"
            size="icon-sm"
            aria-label={t("home:widgets.chatPin.collapseAria", { title })}
            title={t("home:widgets.chatPin.collapseAria", { title })}
            onClick={onCollapse}
          >
            <IconArrowsMinimize aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="subtle"
            size="icon-sm"
            aria-label={t("home:widgets.chatPin.openFullAria", { title })}
            title={t("home:widgets.chatPin.openFullAria", { title })}
            onClick={onOpenFullChat}
          >
            <IconArrowsMaximize aria-hidden="true" />
          </Button>
        </div>
      </header>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: transcript body click grants ephemeral canvas composer focus after the canvas gesture classifier. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users focus the composer directly; this handler classifies pointer click ownership only. */}
      <div
        data-canvas-chat-activation="transcript"
        data-home-canvas-interactive="true"
        className="relative flex min-h-0 flex-1 cursor-text flex-col select-text touch-pan-y"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={focusAndMarkRead}
      >
        <ChatTranscriptSurface
          sessionId={session.id}
          messages={boundedTranscript.messages}
          streamingMessageId={streamingMessageId}
          isLoadingHistory={transcript.isLoadingHistory}
          selectedPersona={transcript.selectedPersona}
          sessionCwd={transcript.sessionArtifactCwd}
          rendererPolicy="classic"
          startContent={
            boundedTranscript.hasOmittedExchanges ? (
              <div
                data-testid="canvas-chat-history-boundary"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 text-xs text-muted-foreground"
              >
                <span>{t("home:widgets.chatPin.earlierMessages")}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  flush
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenFullChat();
                  }}
                >
                  {t("home:widgets.chatPin.openFull")}
                </Button>
              </div>
            ) : null
          }
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this normal-flow surface classifies pointer ownership while its nested composer controls retain keyboard semantics. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the nested composer controls and focus capture. */}
      <div
        data-home-canvas-interactive="true"
        className="shrink-0 cursor-default px-2 pb-2"
        onPointerDown={(event) => {
          event.stopPropagation();
          activateComposerFromPointer();
        }}
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={activateComposerFromFocus}
      >
        <CanvasCardComposer
          session={session}
          onCreatePersona={onCreatePersona}
          onCreateProject={onCreateProject}
          onWorkspaceNameRequest={onWorkspaceNameRequest}
        />
      </div>
    </section>
  );
}
