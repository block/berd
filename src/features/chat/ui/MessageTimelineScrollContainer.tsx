import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/lib/cn";
import { ScrollIntentArea } from "@/shared/ui/scroll-intent-area";

const MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS = "relative z-0 min-h-0 flex-1";

interface MessageTimelineScrollContainerProps
  extends ComponentPropsWithoutRef<"div"> {
  hasFooter: boolean;
}

export const MessageTimelineScrollContainer = forwardRef<
  HTMLDivElement,
  MessageTimelineScrollContainerProps
>(({ children, className, hasFooter, ...props }, forwardedRef) => (
  <ScrollIntentArea
    {...props}
    ref={forwardedRef}
    data-testid="message-timeline-scroll"
    className={cn(
      MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS,
      !hasFooter && "rounded-md bg-card",
      className,
    )}
  >
    {children}
  </ScrollIntentArea>
));

MessageTimelineScrollContainer.displayName = "MessageTimelineScrollContainer";
