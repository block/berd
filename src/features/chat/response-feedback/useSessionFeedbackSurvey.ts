import { useEffect, useMemo, useState } from "react";
import { getUserVisibleMessageContent } from "@/features/chat/transcript/projection";
import type { Message } from "@/shared/types/messages";
import { isResponseFeedbackEligible } from "./responseFeedbackState";
import {
  type ActiveSessionFeedbackSurvey,
  claimSessionFeedbackSurvey,
  SESSION_SURVEY_MINIMUM_AGE_MS,
} from "./sessionFeedbackSurveyState";

export function useSessionFeedbackSurvey({
  sessionId,
  sessionCreatedAt,
  messages,
  streamingMessageId,
  responsePending,
  samplingRateBasisPoints,
}: {
  sessionId: string;
  sessionCreatedAt?: string;
  messages: readonly Message[];
  streamingMessageId?: string | null;
  responsePending: boolean;
  samplingRateBasisPoints: number;
}): ActiveSessionFeedbackSurvey | null {
  const [ageThresholdEvaluation, setAgeThresholdEvaluation] = useState<{
    sessionCreatedAt: string;
    now: number;
  } | null>(null);
  useEffect(() => {
    if (!sessionCreatedAt) return;
    const remaining =
      Date.parse(sessionCreatedAt) + SESSION_SURVEY_MINIMUM_AGE_MS - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timeout = window.setTimeout(
      () => setAgeThresholdEvaluation({ sessionCreatedAt, now: Date.now() }),
      remaining,
    );
    return () => window.clearTimeout(timeout);
  }, [sessionCreatedAt]);

  const candidate = useMemo(() => {
    if (!sessionCreatedAt || samplingRateBasisPoints <= 0) {
      return null;
    }
    let userTurnCount = 0;
    let message: Message | null = null;
    for (const current of messages) {
      if (
        current.role === "user" &&
        current.metadata?.userVisible !== false &&
        getUserVisibleMessageContent(current.content).some(
          (content) => content.type !== "toolResponse",
        )
      ) {
        userTurnCount += 1;
      }
      if (
        isResponseFeedbackEligible({
          message: current,
          content: current.content,
          isStreaming: current.id === streamingMessageId,
        })
      ) {
        message = current;
      }
    }
    return message
      ? {
          messageId: message.id,
          userTurnCount,
          currentMessageIds: new Set(messages.map((current) => current.id)),
          now:
            ageThresholdEvaluation?.sessionCreatedAt === sessionCreatedAt
              ? ageThresholdEvaluation.now
              : Date.now(),
        }
      : null;
  }, [
    ageThresholdEvaluation,
    messages,
    samplingRateBasisPoints,
    sessionCreatedAt,
    streamingMessageId,
  ]);
  const [surveyState, setSurveyState] = useState<{
    sessionId: string;
    survey: ActiveSessionFeedbackSurvey | null;
  }>({ sessionId, survey: null });

  useEffect(() => {
    let cancelled = false;
    if (responsePending) {
      return () => {
        cancelled = true;
      };
    }
    if (!candidate || !sessionCreatedAt) {
      setSurveyState({ sessionId, survey: null });
      return () => {
        cancelled = true;
      };
    }
    void claimSessionFeedbackSurvey({
      sessionId,
      messageId: candidate.messageId,
      currentMessageIds: candidate.currentMessageIds,
      sessionCreatedAt,
      userTurnCount: candidate.userTurnCount,
      samplingRateBasisPoints,
      now: candidate.now,
    }).then((survey) => {
      if (!cancelled) setSurveyState({ sessionId, survey });
    });
    return () => {
      cancelled = true;
    };
  }, [
    candidate,
    responsePending,
    samplingRateBasisPoints,
    sessionCreatedAt,
    sessionId,
  ]);

  return surveyState.sessionId === sessionId ? surveyState.survey : null;
}
