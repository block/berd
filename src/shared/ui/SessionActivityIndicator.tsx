import { useReducedMotion } from "motion/react";

import { cn } from "@/shared/lib/cn";
import { RESPONDING_SHIMMER_PROPS } from "@/shared/ui/ai-elements/shimmer";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";

const ACTIVE_CHAT_BERD_SIZE_PX = 14;
const WORKING_INDICATOR_ENTRANCE_CLASSES =
  "transition-opacity duration-200 ease-out animate-in fade-in-0";

interface SessionActivityIndicatorProps {
  isRunning?: boolean;
  hasUnread?: boolean;
  variant?: "inline" | "overlay";
  className?: string;
}

export function ActiveChatBerdIndicator({
  className,
  respectAnimationPreference = false,
  size = ACTIVE_CHAT_BERD_SIZE_PX,
}: {
  className?: string;
  respectAnimationPreference?: boolean;
  size?: number;
}) {
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    !shouldReduceMotion &&
    (!respectAnimationPreference ||
      workingIndicatorAnimationPreference.enabled);

  return (
    <BerdLoaderInline
      animated={motionEnabled}
      className={className}
      decorative
      size={size}
    />
  );
}

export function ActiveChatPulseDot({ className }: { className?: string }) {
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    workingIndicatorAnimationPreference.enabled && !shouldReduceMotion;

  return (
    <span
      aria-hidden="true"
      data-slot="active-chat-pulse-dot"
      className={cn(
        "size-[7px] rounded-full bg-info",
        motionEnabled && "animate-[active-chat-dot-pulse_ease-in-out_infinite]",
        className,
      )}
      style={
        motionEnabled
          ? {
              animationDuration: `${RESPONDING_SHIMMER_PROPS.duration}s`,
            }
          : undefined
      }
    />
  );
}

export function SessionActivityIndicator({
  isRunning = false,
  hasUnread = false,
  variant = "inline",
  className,
}: SessionActivityIndicatorProps) {
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    workingIndicatorAnimationPreference.enabled && !shouldReduceMotion;

  if (isRunning) {
    if (variant === "overlay") {
      return (
        <span
          role="status"
          aria-label="Chat active"
          className={cn(
            "absolute -right-1 -top-1 flex items-center justify-center",
            motionEnabled && WORKING_INDICATOR_ENTRANCE_CLASSES,
            className,
          )}
        >
          <BerdLoaderInline
            animated={motionEnabled}
            decorative
            size={ACTIVE_CHAT_BERD_SIZE_PX}
          />
        </span>
      );
    }

    return (
      <span
        role="status"
        aria-label="Chat active"
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          motionEnabled && WORKING_INDICATOR_ENTRANCE_CLASSES,
          className,
        )}
      >
        <BerdLoaderInline
          animated={motionEnabled}
          decorative
          size={ACTIVE_CHAT_BERD_SIZE_PX}
        />
      </span>
    );
  }

  if (!hasUnread) {
    return null;
  }

  if (variant === "overlay") {
    return (
      <span
        role="status"
        aria-label="Unread messages"
        className={cn(
          "absolute -right-0.5 -top-0.5 h-2 w-2 shrink-0 rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0",
          className,
        )}
      />
    );
  }

  return (
    <span
      role="status"
      aria-label="Unread messages"
      className={cn(
        "h-2 w-2 shrink-0 rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0",
        className,
      )}
    />
  );
}
