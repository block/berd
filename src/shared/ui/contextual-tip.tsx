import type * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

interface ContextualTipProps extends React.ComponentProps<"div"> {
  actionLabel?: string;
  dismissLabel: string;
  icon?: React.ReactNode;
  iconClassName?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

function ContextualTip({
  actionLabel,
  children,
  className,
  dismissLabel,
  icon,
  iconClassName,
  onAction,
  onDismiss,
  ...props
}: ContextualTipProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-8 w-fit max-w-full origin-bottom items-center gap-1.5 rounded-full border border-border-soft bg-background px-1.5 py-1 text-xs text-foreground shadow-mini transition-[box-shadow,border-color] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:zoom-in-95 motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
            iconClassName,
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate px-1 text-[13px] leading-5">
        {children}
      </span>
      {actionLabel && onAction ? (
        <Button
          type="button"
          variant="inline-subtle"
          size="xxs"
          className="h-6 rounded-full bg-muted/70 px-2 text-[11px] text-foreground hover:bg-muted"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6 shrink-0 text-muted-foreground/70 hover:text-foreground"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

export { ContextualTip };
