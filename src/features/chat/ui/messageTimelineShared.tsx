import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronsDown, IconChevronsUp } from "@tabler/icons-react";
import type { RunCommandOptions } from "@/shared/ui/ai-elements/runnable-code-block";
import { JumpToLatestButton } from "@/shared/ui/jump-to-latest-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_GROUP_LABEL_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";
import type { Message } from "@/shared/types/messages";
import type { McpAppMessageHandler } from "./mcpAppTypes";

export function getVoiceSubmissionKey(
  message: Message | undefined,
): string | null {
  if (
    message?.role !== "user" ||
    message.metadata?.origin !== "voice_conversation"
  ) {
    return null;
  }

  const utteranceId = message.metadata.voiceUtteranceId;
  if (!utteranceId) {
    return message.id;
  }

  return [
    message.metadata.voiceConversationLifecycleId ?? "",
    utteranceId,
    message.metadata.voiceConversationRevision ?? "",
  ].join(":");
}

export function getTimelineMessageIdentity(message: Message): string {
  const voiceSubmissionKey = getVoiceSubmissionKey(message);
  return voiceSubmissionKey
    ? `voice:${voiceSubmissionKey}`
    : `message:${message.id}`;
}

export interface MessageBubbleCallbacks {
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onJumpToResponseStart?: (messageId: string) => void;
  onForkFromMessage?: (messageId: string) => void;
  onJumpToResponseStartHintClose?: (messageId: string) => void;
  onJumpToResponseStartHintDismiss?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
  onEditProject?: (projectId: string) => void;
  onChangeFolder?: () => void;
  onOpenContextPanel?: () => void;
}

export type MessageTimelineBubbleCallbacks = Omit<
  MessageBubbleCallbacks,
  "onMcpAppAutoScroll"
>;

// Hide delay for the per-message jump-to-response-start hint's relevance gate.
// The gate is a raw per-frame position check, so scrolling the message's action
// chevron through the reading band drops it the instant the chevron crosses an
// edge — and a fast sweep tears the popover down before its fade-in finishes,
// which is what made the animation restart mid-flight. The hint shows the
// moment its chevron enters the band, but stays up this long after the gate
// drops: long enough for the enter animation to finish, to swallow a quick
// out-and-back, and to turn every real hide into one clean exit.
export const RESPONSE_START_HINT_HIDE_DELAY_MS = 200;

/**
 * Sticky boolean: turns on immediately with `value`, but only turns off after
 * `value` has stayed false for `hideDelayMs`. A `value` that flips back to true
 * within the window cancels the pending off, so transient drops never reach the
 * returned flag. Used to keep the jump-to-response-start hint from flickering
 * (and from interrupting its own fade) as the reader scrolls its chevron across
 * the relevance band.
 */
export function useStickyFlag(value: boolean, hideDelayMs: number): boolean {
  const [delayedOff, setDelayedOff] = useState(value);
  useEffect(() => {
    if (value) {
      setDelayedOff(true);
      return;
    }
    if (!delayedOff) {
      return;
    }
    const timeoutId = setTimeout(() => setDelayedOff(false), hideDelayMs);
    return () => clearTimeout(timeoutId);
  }, [value, delayedOff, hideDelayMs]);
  return value || delayedOff;
}

// Fraction of the visible transcript height, measured down from the top edge,
// that counts as "scrolled past" for the jump-to-response-start hint. Once the
// message's action chevron rises into this band (or above it), the reader has
// moved on, so the hint stops being relevant. Generous by design — a thin slop
// reads as "still reading this" when the user has clearly scrolled away.
const RESPONSE_START_HINT_RELEVANCE_BAND_RATIO = 0.4;
// Dead zone, in pixels, around the relevance-band boundary. The gate is a
// single position threshold, so without hysteresis the frame-to-frame jitter of
// a scroll gesture — trackpad reversals, momentum bounce, virtual-row
// re-measurement — straddles that line and thrashes the boolean, which restarts
// the hint popover's fade. Once active, the chevron must rise clearly past the
// band before the hint deactivates; once inactive, it must drop clearly back
// inside before it reactivates. A single crossing then yields exactly one fade,
// while a deliberate scroll back into the band still brings the hint back.
const RESPONSE_START_HINT_RELEVANCE_HYSTERESIS_PX = 48;

/**
 * Pure relevance gate for the per-message jump-to-response-start hint, shared by
 * the legacy and virtual renderers so the band/hysteresis policy can't drift
 * between them. The hint is relevant only while the message's action chevron
 * sits below the top relevance band and above the composer/footer edge; that
 * single position check subsumes every off-zone case (scrolled above the top,
 * parked near the top, pushed below the composer). `wasActive` carries the
 * previous gate state so the top boundary applies hysteresis and a single
 * crossing yields exactly one fade.
 *
 * Coordinates share one origin per renderer — the legacy renderer passes
 * absolute viewport coordinates (`containerTop` = the container's top edge), the
 * virtual renderer passes viewport-relative coordinates (`containerTop` = 0) —
 * with `chevronY` and `visibleBottom` measured in that same space.
 */
export function isResponseStartHintInRelevanceBand({
  chevronY,
  containerTop,
  visibleBottom,
  wasActive,
}: {
  /** Bottom edge of the message's final row, where the action chevron renders. */
  chevronY: number;
  /** Top edge of the visible transcript (0 for viewport-relative coordinates). */
  containerTop: number;
  /** Bottom edge of the visible transcript, clamped above the composer/footer. */
  visibleBottom: number;
  /** Previous gate state, used to apply the top-boundary hysteresis. */
  wasActive: boolean;
}): boolean {
  const visibleHeight = Math.max(0, visibleBottom - containerTop);
  const relevanceBand =
    visibleHeight * RESPONSE_START_HINT_RELEVANCE_BAND_RATIO;
  // Widen the band's top edge while active and tighten it while inactive, so a
  // single crossing can't flip-flop the gate across one scroll gesture.
  const topBoundary =
    containerTop +
    relevanceBand +
    (wasActive
      ? -RESPONSE_START_HINT_RELEVANCE_HYSTERESIS_PX
      : RESPONSE_START_HINT_RELEVANCE_HYSTERESIS_PX);
  return chevronY > topBoundary && chevronY < visibleBottom;
}

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
  visible = true,
}: {
  compact: boolean;
  label: string;
  onClick: () => void;
  visible?: boolean;
}) {
  const fadeClassName = cn(
    "inline-flex shrink-0 will-change-[opacity] motion-safe:transition-opacity motion-safe:duration-[450ms] motion-safe:ease-in-out motion-reduce:transition-none",
    visible
      ? "pointer-events-auto opacity-100"
      : "pointer-events-none opacity-0",
  );
  const handleClick = () => {
    if (visible) {
      onClick();
    }
  };

  if (compact) {
    return (
      <span
        data-jump-to-latest-state={visible ? "visible" : "hidden"}
        className={fadeClassName}
      >
        <JumpToLatestButton
          type="button"
          size="icon-sm"
          onClick={handleClick}
          aria-hidden={!visible}
          tabIndex={visible ? undefined : -1}
          aria-label={label}
          tooltip={label}
        >
          <IconChevronsDown aria-hidden="true" />
        </JumpToLatestButton>
      </span>
    );
  }

  return (
    <span
      data-jump-to-latest-state={visible ? "visible" : "hidden"}
      className={fadeClassName}
    >
      <JumpToLatestButton
        type="button"
        size="sm"
        onClick={handleClick}
        aria-hidden={!visible}
        tabIndex={visible ? undefined : -1}
        leftIcon={<IconChevronsDown />}
      >
        {label}
      </JumpToLatestButton>
    </span>
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
              <JumpToLatestButton
                type="button"
                size="icon-sm"
                // Matched fade in/out. Scroll only controls the visible state;
                // CSS owns the transition so short messages still get a clear
                // entrance and exit.
                className={cn(
                  "will-change-[opacity] motion-safe:transition-opacity motion-safe:duration-[450ms] motion-safe:ease-in-out motion-reduce:transition-none",
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
              </JumpToLatestButton>
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
        <div className="pointer-events-none">{jumpToLatestButton}</div>
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
