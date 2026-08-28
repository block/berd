import { useCallback, useSyncExternalStore } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { MessageAction } from "@/shared/ui/ai-elements/message";
import {
  getResponseFeedbackSelection,
  setResponseFeedbackSelection,
  subscribeResponseFeedbackSelection,
} from "./responseFeedbackState";

interface ResponseFeedbackControlsProps {
  sessionId: string;
  messageId: string;
}

export function ResponseFeedbackControls({
  sessionId,
  messageId,
}: ResponseFeedbackControlsProps) {
  const { t } = useTranslation("chat");
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeResponseFeedbackSelection(sessionId, messageId, onStoreChange),
    [messageId, sessionId],
  );
  const getSnapshot = useCallback(
    () => getResponseFeedbackSelection(sessionId, messageId),
    [messageId, sessionId],
  );
  const selection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const select = (requested: "good" | "bad") => {
    const current = getResponseFeedbackSelection(sessionId, messageId);
    const next = current === requested ? null : requested;
    setResponseFeedbackSelection(sessionId, messageId, next);
  };
  const goodSelected = selection === "good";
  const badSelected = selection === "bad";
  const selectedClassName =
    "bg-accent text-foreground hover:bg-accent active:bg-accent";

  return (
    <span className="inline-flex">
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
