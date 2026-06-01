import { useReducedMotion } from "motion/react";

import startupLoadingChatGif from "@/app/assets/startup-loading-chat.gif";
import startupLoadingPoster from "@/app/assets/startup-loading-poster.png";
import { cn } from "@/shared/lib/cn";

const ACTIVE_CHAT_GOOSE_SIZE_PX = 14;

interface SessionActivityIndicatorProps {
  isRunning?: boolean;
  hasUnread?: boolean;
  variant?: "inline" | "overlay";
  className?: string;
}

export function ActiveChatGooseIndicator({
  className,
  size = ACTIVE_CHAT_GOOSE_SIZE_PX,
}: {
  className?: string;
  size?: number;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <img
      src={shouldReduceMotion ? startupLoadingPoster : startupLoadingChatGif}
      alt=""
      aria-hidden
      className={cn("pointer-events-none object-contain", className)}
      style={{ width: size, height: size }}
      decoding="async"
    />
  );
}

export function SessionActivityIndicator({
  isRunning = false,
  hasUnread = false,
  variant = "inline",
  className,
}: SessionActivityIndicatorProps) {
  if (isRunning) {
    if (variant === "overlay") {
      return (
        <span
          role="status"
          aria-label="Chat active"
          className={cn(
            "absolute -right-1 -top-1 flex items-center justify-center transition-opacity duration-200 ease-out animate-in fade-in-0",
            className,
          )}
        >
          <ActiveChatGooseIndicator size={ACTIVE_CHAT_GOOSE_SIZE_PX} />
        </span>
      );
    }

    return (
      <span
        role="status"
        aria-label="Chat active"
        className={cn(
          "inline-flex shrink-0 items-center justify-center animate-in fade-in-0 duration-200 ease-out",
          className,
        )}
      >
        <ActiveChatGooseIndicator size={ACTIVE_CHAT_GOOSE_SIZE_PX} />
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
