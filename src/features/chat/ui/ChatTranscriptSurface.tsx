import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { Persona } from "@/shared/types/agents";
import type { Message } from "@/shared/types/messages";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { ArtifactPolicyProvider } from "@/features/chat/hooks/ArtifactPolicyContext";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { useSessionFeedbackSurvey } from "../response-feedback/useSessionFeedbackSurvey";
import { ChatLoadingSkeleton } from "./ChatLoadingSkeleton";
import { ConversationEmptyAvatar } from "./ConversationEmptyAvatar";
import {
  VirtualMessageTimelineGate,
  type TranscriptRendererPolicy,
} from "./VirtualMessageTimelineGate";

type TimelineCallbacks = Pick<
  ComponentProps<typeof VirtualMessageTimelineGate>,
  | "onSendMcpAppMessage"
  | "onRunShellCommand"
  | "onEditProject"
  | "onChangeFolder"
  | "onOpenContextPanel"
  | "onForkFromMessage"
>;

export interface ChatTranscriptSurfaceProps extends TimelineCallbacks {
  sessionId: string;
  messages: Message[];
  sessionCreatedAt?: string;
  sessionSurveySamplingRateBasisPoints?: number;
  streamingMessageId?: string | null;
  responsePending?: boolean;
  isLoadingHistory: boolean;
  selectedPersona?: Persona | null;
  sessionCwd?: string | null;
  scrollTargetMessageId?: string | null;
  scrollTargetQuery?: string | null;
  onScrollTargetHandled?: (messageId: string) => void;
  searchContentRef?: RefObject<HTMLDivElement | null>;
  searchBackendRef?: RefObject<TranscriptSearchBackend | null>;
  startContent?: ReactNode;
  footer?: ReactNode;
  footerStatus?: ReactNode;
  suppressEmptyPlaceholder?: boolean;
  /** The owning surface chooses presentation; full chat stays automatic. */
  rendererPolicy?: TranscriptRendererPolicy;
}

function shouldStageInitialTranscript(
  messages: readonly unknown[],
  isLoadingHistory: boolean,
): boolean {
  return messages.length > 0 && !isLoadingHistory;
}

/**
 * Chat-owned transcript lifecycle and rendering. Every mount keeps independent
 * scroll/search state while sharing the session-addressed message/runtime data.
 */
export function ChatTranscriptSurface({
  sessionId,
  messages,
  sessionCreatedAt,
  sessionSurveySamplingRateBasisPoints = 0,
  streamingMessageId,
  responsePending = false,
  isLoadingHistory,
  selectedPersona,
  sessionCwd,
  scrollTargetMessageId,
  scrollTargetQuery,
  onScrollTargetHandled,
  searchContentRef,
  searchBackendRef,
  startContent,
  footer,
  footerStatus,
  suppressEmptyPlaceholder = false,
  rendererPolicy = "auto",
  ...callbacks
}: ChatTranscriptSurfaceProps) {
  const { t } = useTranslation("chat");
  const retainMountedTranscript = useChatStore(
    (state) => state.retainMountedTranscript,
  );
  const [initialGate, setInitialGate] = useState(() => ({
    sessionId,
    pending: shouldStageInitialTranscript(messages, isLoadingHistory),
  }));
  const shouldStage = shouldStageInitialTranscript(messages, isLoadingHistory);
  const isPreparing =
    initialGate.sessionId === sessionId ? initialGate.pending : shouldStage;
  const showLoading = isLoadingHistory || isPreparing;
  const timelineMessages = isPreparing ? [] : messages;
  const sessionFeedbackSurvey = useSessionFeedbackSurvey({
    sessionId,
    sessionCreatedAt,
    messages: timelineMessages,
    streamingMessageId,
    responsePending,
    samplingRateBasisPoints: sessionSurveySamplingRateBasisPoints,
  });

  useEffect(
    () => retainMountedTranscript(sessionId),
    [retainMountedTranscript, sessionId],
  );

  // Only stage the first populated paint. Live updates stay in the mounted
  // timeline and preserve this mount's scroll state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId resets the one-time gate.
  useEffect(() => {
    const pending = shouldStageInitialTranscript(messages, isLoadingHistory);
    setInitialGate((current) =>
      current.sessionId === sessionId && current.pending === pending
        ? current
        : { sessionId, pending },
    );
    if (!pending) return;
    return scheduleAfterNextPaint(() => {
      setInitialGate((current) =>
        current.sessionId === sessionId && current.pending
          ? { sessionId, pending: false }
          : current,
      );
    });
  }, [sessionId]);

  const placeholder = showLoading ? (
    <ChatLoadingSkeleton />
  ) : suppressEmptyPlaceholder ? (
    <div className="flex w-full flex-1" aria-hidden="true" />
  ) : (
    <div className="flex w-full flex-1 flex-col items-center justify-center px-6">
      <AnimatePresence initial={false}>
        {selectedPersona ? (
          <motion.div
            key="conversation-empty-avatar"
            className="overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <div className="pb-4">
              <ConversationEmptyAvatar persona={selectedPersona} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <p className="text-sm font-normal text-foreground">
        {t("emptyState.startAConversation")}
      </p>
    </div>
  );

  return (
    <ArtifactPolicyProvider
      messages={timelineMessages}
      sessionCwd={sessionCwd ?? null}
      sessionId={sessionId}
    >
      <VirtualMessageTimelineGate
        sessionId={sessionId}
        messages={timelineMessages}
        streamingMessageId={streamingMessageId}
        sessionFeedbackSurvey={sessionFeedbackSurvey}
        scrollTargetMessageId={scrollTargetMessageId}
        scrollTargetQuery={scrollTargetQuery}
        onScrollTargetHandled={onScrollTargetHandled}
        searchContentRef={searchContentRef}
        searchBackendRef={searchBackendRef}
        showPlaceholder={showLoading}
        placeholder={placeholder}
        startContent={startContent}
        footer={footer}
        footerStatus={footerStatus}
        rendererPolicy={rendererPolicy}
        {...callbacks}
      />
    </ArtifactPolicyProvider>
  );
}
