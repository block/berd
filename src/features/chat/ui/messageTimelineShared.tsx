import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronsDown, IconChevronsUp } from "@tabler/icons-react";
import type { RunCommandOptions } from "@/shared/ui/ai-elements/runnable-code-block";
import { Button } from "@/shared/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_GROUP_LABEL_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";
import type { McpAppMessageHandler } from "./mcpAppTypes";

export interface MessageBubbleCallbacks {
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onJumpToResponseStart?: (messageId: string) => void;
  onJumpToResponseStartHintClose?: (messageId: string) => void;
  onJumpToResponseStartHintDismiss?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
  onEditProject?: (projectId: string) => void;
  onOpenContextPanel?: () => void;
}

export type MessageTimelineBubbleCallbacks = Omit<
  MessageBubbleCallbacks,
  "onMcpAppAutoScroll"
>;

export function MessageDateSeparator({ label }: { label?: string }) {
  return (
    <div className="my-4 px-4 text-center">
      <span
        className={cn(SIDEBAR_GROUP_LABEL_TEXT_CLASS, "text-muted-foreground")}
      >
        {label}
      </span>
    </div>
  );
}

export function MessageTimelineEmptyState() {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium font-display tracking-tight text-muted-foreground">
          {t("timeline.emptyTitle")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("timeline.emptyDescription")}
        </p>
      </div>
    </div>
  );
}

export function MessageTimelineJumpToLatestButton({
  compact,
  label,
  onClick,
}: {
  compact: boolean;
  label: string;
  onClick: () => void;
}) {
  if (compact) {
    return (
      <Button
        type="button"
        variant="jump-to-latest"
        size="icon-sm"
        onClick={onClick}
        aria-label={label}
        title={label}
      >
        <IconChevronsDown aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="jump-to-latest"
      size="sm"
      onClick={onClick}
      leftIcon={<IconChevronsDown />}
    >
      {label}
    </Button>
  );
}

/** How far up from the composer the gutter chevron floats, as a fraction of the
 * visible transcript height. The targeting anchor stays bottom-aligned; this is
 * only a visual lift so the button is easier to notice without feeling centered. */
export const GUTTER_RESPONSE_START_LIFT_RATIO = 0.18;

/** Floating chevron pinned in the transcript's left gutter, a little above the
 * composer, that jumps back to the top of the agent message the reader is
 * currently scrolled inside. It reuses the exact "jump to response start"
 * handler from the message action row, so the scroll feel and target stay
 * identical — it's just always within reach while reading a long reply.
 *
 * Scroll decides whether the button should be visible; CSS handles a matched
 * fade in/out. The target is retained across visibility changes so delayed
 * events never resolve against a missing message id. */
export function MessageTimelineJumpToResponseStartGutterButton({
  label,
  ariaLabel,
  bottomOffsetPx,
  visible,
  messageId,
  onJump,
}: {
  label: string;
  ariaLabel: string;
  bottomOffsetPx: number;
  visible: boolean;
  /** Target message; retained via the ref below so the button still resolves a
   * valid target while it is fading out. */
  messageId: string | null;
  onJump: (messageId: string) => void;
}) {
  const lastMessageIdRef = useRef<string | null>(messageId);
  if (messageId) {
    lastMessageIdRef.current = messageId;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
      style={{
        bottom: `calc(${bottomOffsetPx}px + ${GUTTER_RESPONSE_START_LIFT_RATIO * 100}%)`,
      }}
    >
      <div className="flex w-full max-w-[var(--chat-transcript-container-max-width)] justify-start px-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="jump-to-latest"
                size="icon-sm"
                // Matched fade in/out. Scroll only controls the visible state;
                // CSS owns the transition so short messages still get a clear
                // entrance and exit.
                className={cn(
                  "motion-safe:transition-opacity motion-safe:duration-[450ms] motion-safe:ease-in-out motion-reduce:transition-none",
                  visible
                    ? "pointer-events-auto opacity-100"
                    : "pointer-events-none opacity-0",
                )}
                aria-hidden={!visible}
                tabIndex={visible ? undefined : -1}
                onClick={() => {
                  const target = lastMessageIdRef.current;
                  if (target) {
                    onJump(target);
                  }
                }}
                aria-label={ariaLabel}
              >
                <IconChevronsUp aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{label}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

export function MessageTimelineFooterControlRow({
  footerStatus,
  jumpToLatestButton,
}: {
  footerStatus?: ReactNode;
  jumpToLatestButton?: ReactNode;
}) {
  if (!footerStatus && !jumpToLatestButton) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center gap-2 px-4 pb-2">
      {footerStatus ? (
        <div className="pointer-events-auto">{footerStatus}</div>
      ) : null}
      {jumpToLatestButton ? (
        <div className="pointer-events-auto">{jumpToLatestButton}</div>
      ) : null}
    </div>
  );
}

/** Duration of the jump-to-latest eased scroll glide, shared by both
 * timeline renderers so their scroll feel stays in sync. */
export const JUMP_TO_LATEST_SCROLL_MS = 180;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}
