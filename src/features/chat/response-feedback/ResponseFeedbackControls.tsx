import { useEffect, useRef, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { MessageAction } from "@/shared/ui/ai-elements/message";
import {
  getResponseFeedbackSelection,
  markResponseFeedbackAppeared,
  setResponseFeedbackSelection,
  type ResponseFeedbackSelection,
} from "./responseFeedbackState";

interface ResponseFeedbackControlsProps {
  sessionId: string;
  messageId: string;
  persistentlyVisible: boolean;
}

export function ResponseFeedbackControls({
  sessionId,
  messageId,
  persistentlyVisible,
}: ResponseFeedbackControlsProps) {
  const { t } = useTranslation("chat");
  const controlsRef = useRef<HTMLSpanElement>(null);
  const [selection, setSelection] = useState<ResponseFeedbackSelection | null>(
    () => getResponseFeedbackSelection(sessionId, messageId),
  );

  useEffect(() => {
    setSelection(getResponseFeedbackSelection(sessionId, messageId));
  }, [messageId, sessionId]);

  useEffect(() => {
    const target = controlsRef.current;
    if (
      !persistentlyVisible ||
      !target ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        markResponseFeedbackAppeared(sessionId, messageId);
        observer.disconnect();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [messageId, persistentlyVisible, sessionId]);

  const select = (requested: ResponseFeedbackSelection) => {
    const current = getResponseFeedbackSelection(sessionId, messageId);
    const next = current === requested ? null : requested;
    setSelection(setResponseFeedbackSelection(sessionId, messageId, next));
  };
  const goodSelected = selection === "good";
  const badSelected = selection === "bad";
  const selectedClassName =
    "bg-accent text-foreground hover:bg-accent active:bg-accent";

  return (
    <span
      ref={controlsRef}
      className="inline-flex"
      onPointerEnter={() => markResponseFeedbackAppeared(sessionId, messageId)}
      onFocusCapture={() => markResponseFeedbackAppeared(sessionId, messageId)}
    >
      <MessageAction
        size="icon-xs"
        variant="ghost"
        className={cn(
          "text-muted-foreground/80",
          goodSelected && selectedClassName,
        )}
        label={t("message.responseFeedbackGood")}
        tooltip={t("message.responseFeedbackGood")}
        aria-pressed={goodSelected}
        onClick={() => select("good")}
      >
        <ThumbsUp className="size-3.5" />
      </MessageAction>
      <MessageAction
        size="icon-xs"
        variant="ghost"
        className={cn(
          "text-muted-foreground/80",
          badSelected && selectedClassName,
        )}
        label={t("message.responseFeedbackBad")}
        tooltip={t("message.responseFeedbackBad")}
        aria-pressed={badSelected}
        onClick={() => select("bad")}
      >
        <ThumbsDown className="size-3.5" />
      </MessageAction>
    </span>
  );
}
