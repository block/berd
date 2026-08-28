import type { ReactNode } from "react";
import { Check, Copy, Split, Pencil, RotateCcw, X } from "lucide-react";
import { IconChevronsUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { MessageAction, MessageActions } from "@/shared/ui/ai-elements/message";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Button } from "@/shared/ui/button";
import { ResponseFeedbackControls } from "../response-feedback/ResponseFeedbackControls";

interface MessageBubbleActionsProps {
  isUser: boolean;
  messageId: string;
  timestamp: ReactNode;
  textContent: string;
  copied: boolean;
  onCopy: () => void;
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onJumpToResponseStart?: (messageId: string) => void;
  onForkFromMessage?: (messageId: string) => void;
  showJumpToResponseStartHint?: boolean;
  responseFeedback?: {
    sessionId: string;
    messageId: string;
  };
  onJumpToResponseStartHintClose?: (messageId: string) => void;
  onJumpToResponseStartHintDismiss?: (messageId: string) => void;
}

export function MessageBubbleActions({
  isUser,
  messageId,
  timestamp,
  textContent,
  copied,
  onCopy,
  onRetryMessage,
  onEditMessage,
  onJumpToResponseStart,
  onForkFromMessage,
  showJumpToResponseStartHint,
  responseFeedback,
  onJumpToResponseStartHintClose,
  onJumpToResponseStartHintDismiss,
}: MessageBubbleActionsProps) {
  const { t } = useTranslation(["chat", "common"]);
  const jumpToResponseStartLabel = t("message.jumpToResponseStart");
  const forkFromHereLabel = t("message.forkFromHere");
  const copyLabel = copied ? t("message.copied") : t("common:actions.copy");
  const copyTooltip = showJumpToResponseStartHint ? undefined : copyLabel;
  const jumpToResponseStartAction = onJumpToResponseStart ? (
    <MessageAction
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground/80"
      label={jumpToResponseStartLabel}
      // Use a native title for the hover affordance instead of MessageAction's
      // Radix tooltip. The shared tooltip opens with zero delay, so when the
      // rich hint popover closes (the gate drops as the chevron scrolls off the
      // bottom) Radix returns focus to this trigger and instantly flashes a
      // label-only bubble — a smaller, subtitle-less "ghost" of the hint. A
      // native title only shows on a deliberate rested hover and ignores focus,
      // so it can't glitch during the hide. Suppressed while the hint shows.
      title={showJumpToResponseStartHint ? undefined : jumpToResponseStartLabel}
      onClick={() => onJumpToResponseStart(messageId)}
    >
      <IconChevronsUp className="size-3.5" />
    </MessageAction>
  ) : null;

  return (
    <MessageActions className="gap-0 pt-0">
      {isUser && timestamp}
      {textContent && (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className={cn(
            "text-muted-foreground/80",
            copied &&
              "bg-accent text-foreground hover:bg-accent active:bg-accent",
          )}
          label={copyLabel}
          tooltip={copyTooltip}
          onClick={onCopy}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </MessageAction>
      )}
      {onForkFromMessage ? (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/80"
          label={forkFromHereLabel}
          tooltip={forkFromHereLabel}
          onClick={() => onForkFromMessage(messageId)}
        >
          <Split className="size-3.5" />
        </MessageAction>
      ) : null}
      {!isUser && jumpToResponseStartAction ? (
        <Popover
          open={!!showJumpToResponseStartHint}
          onOpenChange={(open) => {
            if (!open) {
              onJumpToResponseStartHintClose?.(messageId);
            }
          }}
        >
          <PopoverTrigger asChild>{jumpToResponseStartAction}</PopoverTrigger>
          <PopoverContent
            variant="tooltip"
            align="center"
            side="top"
            onOpenAutoFocus={(event) => event.preventDefault()}
            // The hint closes on a scroll-driven gate flip, not a user action.
            // Don't let Radix yank focus back to the chevron as it unmounts —
            // that focus return is what re-opens the chevron's hover affordance
            // mid-scroll and can scroll the (departing) chevron back into view.
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="max-w-56 p-3"
          >
            <div className="relative">
              <p className="pr-7 text-xs font-medium leading-4">
                {jumpToResponseStartLabel}
              </p>
              <p className="mt-1 text-xs leading-4 text-popover-inverse-foreground/80">
                {t("message.jumpToResponseStartHint")}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-0 top-0 size-4 p-0 text-popover-inverse-foreground/75 hover:bg-transparent hover:text-popover-inverse-foreground"
                aria-label={t("message.jumpToResponseStartHintDismiss")}
                onClick={() => onJumpToResponseStartHintDismiss?.(messageId)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {!isUser && onRetryMessage && (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/80"
          tooltip={t("common:actions.retry")}
          onClick={() => onRetryMessage(messageId)}
        >
          <RotateCcw className="size-3.5" />
        </MessageAction>
      )}
      {isUser && onEditMessage && (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/80"
          tooltip={t("common:actions.edit")}
          onClick={() => onEditMessage(messageId)}
        >
          <Pencil className="size-3.5" />
        </MessageAction>
      )}
      {!isUser && responseFeedback ? (
        <ResponseFeedbackControls
          sessionId={responseFeedback.sessionId}
          messageId={responseFeedback.messageId}
        />
      ) : null}
      {!isUser && timestamp}
    </MessageActions>
  );
}
