import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { MessageBubble } from "./MessageBubble";
import type { McpAppMessageHandler } from "./mcpAppTypes";
import { getTextContent, type Message } from "@/shared/types/messages";

const AUTO_SCROLL_THRESHOLD_PX = 180;
const MCP_APP_STICKY_SCROLL_MS = 1500;

interface MessageTimelineProps {
  messages: Message[];
  streamingMessageId?: string | null;
  scrollTargetMessageId?: string | null;
  scrollTargetQuery?: string | null;
  onScrollTargetHandled?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  className?: string;
  tailPaddingPx?: number;
  /** Pinned to the bottom inside the scroll container so it scrolls natively
      with the conversation behind it (the floating chat composer). */
  footer?: ReactNode;
  /** Shown in place of the message list (empty state or loading skeleton)
      while keeping the scroll container and sticky footer mounted, so the
      composer never remounts between empty, loading, and populated states. */
  placeholder?: ReactNode;
  /** Force the placeholder even when messages exist, e.g. while history is
      still loading. */
  showPlaceholder?: boolean;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDateSeparator(
  timestamp: number,
  todayLabel: string,
  yesterdayLabel: string,
  formatDate: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(timestamp, now.getTime())) return todayLabel;
  if (isSameDay(timestamp, yesterday.getTime())) return yesterdayLabel;

  return formatDate(timestamp, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function MessageTimeline({
  messages,
  streamingMessageId,
  scrollTargetMessageId,
  scrollTargetQuery,
  onScrollTargetHandled,
  onRetryMessage,
  onEditMessage,
  onSendMcpAppMessage,
  className,
  tailPaddingPx,
  footer,
  placeholder,
  showPlaceholder,
}: MessageTimelineProps) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const containerRef = useRef<HTMLDivElement>(null);
  // The composer is a sticky footer inside the scroll container. Wheels and
  // touches that land on it scroll the composer's own text, not the
  // conversation, so the scroll handlers below ignore anything inside this ref.
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isNearBottomRef = useRef(true);
  const userDetachedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const stickyScrollUntilRef = useRef(0);
  const autoScrollTimersRef = useRef<number[]>([]);
  const lastMcpAppSignatureRef = useRef<string | null>(null);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);
  const [userDetached, setUserDetached] = useState(false);
  const visibleMessages = messages.filter(
    (m) =>
      m.metadata?.userVisible !== false &&
      !(
        m.role === "assistant" &&
        m.content.length === 0 &&
        m.metadata?.completionStatus === "inProgress"
      ),
  );
  const resolvedScrollTargetMessageId = useMemo(() => {
    if (scrollTargetMessageId) {
      const exactMatch = visibleMessages.find(
        (message) => message.id === scrollTargetMessageId,
      );
      if (exactMatch) {
        return exactMatch.id;
      }
    }

    const trimmedQuery = scrollTargetQuery?.trim().toLocaleLowerCase();
    if (!trimmedQuery) {
      return null;
    }

    const textMatch = visibleMessages.find((message) =>
      getTextContent(message).toLocaleLowerCase().includes(trimmedQuery),
    );
    return textMatch?.id ?? null;
  }, [scrollTargetMessageId, scrollTargetQuery, visibleMessages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, []);

  const setDetachedFromLatest = useCallback((detached: boolean) => {
    userDetachedRef.current = detached;
    setUserDetached(detached);
  }, []);

  const scrollToBottomIfNearBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      if (userDetachedRef.current) {
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const stickyActive = stickyScrollUntilRef.current > performance.now();

      if (
        !isNearBottomRef.current &&
        !stickyActive &&
        distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX
      ) {
        return;
      }

      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  const schedulePinnedBottomBurst = useCallback(() => {
    if (userDetachedRef.current) {
      return;
    }

    stickyScrollUntilRef.current = performance.now() + MCP_APP_STICKY_SCROLL_MS;

    for (const timer of autoScrollTimersRef.current) {
      window.clearTimeout(timer);
    }
    autoScrollTimersRef.current = [];

    const run = () => {
      scrollToBottom("auto");
    };

    run();

    for (const delay of [120, 300, 650]) {
      const timer = window.setTimeout(() => {
        run();
      }, delay);
      autoScrollTimersRef.current.push(timer);
    }
  }, [scrollToBottom]);

  const requestMcpAppAutoScroll = useCallback((element: HTMLElement | null) => {
    const container = containerRef.current;
    if (!container || !element) {
      return;
    }

    if (userDetachedRef.current) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const shouldStick =
      isNearBottomRef.current ||
      distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX ||
      stickyScrollUntilRef.current > performance.now();

    if (!shouldStick) {
      return;
    }

    stickyScrollUntilRef.current = performance.now() + MCP_APP_STICKY_SCROLL_MS;

    const alignElementBottom = () => {
      const nextContainer = containerRef.current;
      if (!nextContainer || !element.isConnected) {
        return;
      }

      const containerRect = nextContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const footerRect = footerRef.current?.getBoundingClientRect();
      const visibleBottom = footerRect
        ? Math.min(containerRect.bottom, footerRect.top)
        : containerRect.bottom;
      const delta = elementRect.bottom - visibleBottom + 16;

      if (delta > 0) {
        nextContainer.scrollBy({
          top: delta,
          behavior: "auto",
        });
      }
    };

    alignElementBottom();
    requestAnimationFrame(() => {
      alignElementBottom();
    });
  }, []);

  // Use scrollTo instead of scrollIntoView to avoid scrolling parent/document-level ancestors.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable and don't need to be in deps
  useEffect(() => {
    scrollToBottomIfNearBottom();
  }, [messages, scrollToBottomIfNearBottom, streamingMessageId]);

  // The composer reserves bottom padding so messages stay reachable above it.
  // When the composer resizes, that padding (and thus scrollHeight) changes; a
  // user pinned to the bottom would otherwise drift. Re-pin them in BOTH
  // directions. This runs as a layout effect so it fires synchronously after the
  // padding mutation and before paint — reading scrollHeight here forces a fresh
  // measurement, so on shrink we pin to the new (shorter) bottom in the same
  // frame instead of leaving the view parked past the end until the next scroll.
  useLayoutEffect(() => {
    if (tailPaddingPx == null) {
      return;
    }
    if (userDetachedRef.current) {
      return;
    }
    scrollToBottom("auto");
  }, [tailPaddingPx, scrollToBottom]);

  const latestVisibleMessage = visibleMessages.at(-1);
  const latestVisibleMessageId = latestVisibleMessage?.id;

  useEffect(() => {
    if (!latestVisibleMessageId || latestVisibleMessage?.role !== "user") {
      return;
    }

    setDetachedFromLatest(false);
    scrollToBottom("auto");
  }, [
    latestVisibleMessageId,
    latestVisibleMessage?.role,
    scrollToBottom,
    setDetachedFromLatest,
  ]);

  useEffect(() => {
    if (!resolvedScrollTargetMessageId) {
      return;
    }

    const target = messageRefs.current[resolvedScrollTargetMessageId];
    if (!target) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      setPulsingMessageId(resolvedScrollTargetMessageId);
      onScrollTargetHandled?.(resolvedScrollTargetMessageId);
    });

    return () => cancelAnimationFrame(frame);
  }, [onScrollTargetHandled, resolvedScrollTargetMessageId]);

  useEffect(() => {
    if (!pulsingMessageId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPulsingMessageId((current) =>
        current === pulsingMessageId ? null : current,
      );
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [pulsingMessageId]);

  useEffect(
    () => () => {
      for (const timer of autoScrollTimersRef.current) {
        window.clearTimeout(timer);
      }
      autoScrollTimersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const lastMessage = visibleMessages.at(-1);
    if (!lastMessage || lastMessage.role !== "assistant") {
      lastMcpAppSignatureRef.current = null;
      return;
    }

    const mcpAppCount = lastMessage.content.filter(
      (block) => block.type === "mcpApp",
    ).length;
    if (mcpAppCount === 0) {
      lastMcpAppSignatureRef.current = null;
      return;
    }

    const signature = `${lastMessage.id}:${mcpAppCount}:${lastMessage.content.length}`;
    if (lastMcpAppSignatureRef.current === signature) {
      return;
    }
    lastMcpAppSignatureRef.current = signature;

    if (
      isNearBottomRef.current ||
      stickyScrollUntilRef.current > performance.now()
    ) {
      schedulePinnedBottomBurst();
    }
  }, [schedulePinnedBottomBurst, visibleMessages]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;

    const scrollingDown = scrollTop > lastScrollTopRef.current;

    if (
      isNearBottomRef.current &&
      (!userDetachedRef.current || scrollingDown)
    ) {
      setDetachedFromLatest(false);
    } else if (
      userScrollIntentRef.current ||
      scrollTop < lastScrollTopRef.current
    ) {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    }

    lastScrollTopRef.current = scrollTop;
    userScrollIntentRef.current = false;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    // A wheel over the composer scrolls its text, not the conversation, so it
    // must not flip the conversation into the detached "jump to latest" state.
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }

    userScrollIntentRef.current = true;

    if (event.deltaY < 0) {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    }
  };

  const handleUserScrollIntent = (event: SyntheticEvent) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }
    userScrollIntentRef.current = true;
  };

  const handleJumpToLatest = () => {
    setDetachedFromLatest(false);
    isNearBottomRef.current = true;
    scrollToBottom("smooth");
  };

  const jumpToLatestButton = userDetached ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleJumpToLatest}
      leftIcon={<ArrowDown />}
      className="bg-background/95 shadow-sm"
    >
      {t("timeline.jumpToLatest")}
    </Button>
  ) : null;

  const messageList = (
    <div
      className="mx-auto w-full max-w-3xl flex-1 pt-4"
      style={{ paddingBottom: footer ? 16 : (tailPaddingPx ?? 16) }}
    >
      {visibleMessages.map((message, index) => {
        const prev = index > 0 ? visibleMessages[index - 1] : null;
        const showDateSeparator =
          !prev || !isSameDay(prev.created, message.created);

        return (
          <div
            key={message.id}
            ref={(el) => {
              messageRefs.current[message.id] = el;
            }}
            className={cn(
              index === 0 ? "mt-0" : "mt-4",
              "rounded-xl transition-[background-color,box-shadow]",
              pulsingMessageId === message.id &&
                "bg-accent/25 ring-2 ring-accent/35 ring-inset",
            )}
          >
            {showDateSeparator && (
              <div className="my-4 px-4 text-center">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {formatDateSeparator(
                    message.created,
                    t("timeline.today"),
                    t("timeline.yesterday"),
                    formatDate,
                  )}
                </span>
              </div>
            )}
            <MessageBubble
              message={message}
              isStreaming={message.id === streamingMessageId}
              onRetryMessage={
                message.role === "assistant" ? onRetryMessage : undefined
              }
              onEditMessage={
                message.role === "user" ? onEditMessage : undefined
              }
              onSendMcpAppMessage={onSendMcpAppMessage}
              onMcpAppAutoScroll={requestMcpAppAutoScroll}
            />
          </div>
        );
      })}
    </div>
  );

  const defaultEmptyState = (
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

  const showPlaceholderContent =
    showPlaceholder || visibleMessages.length === 0;
  const content = showPlaceholderContent
    ? (placeholder ?? defaultEmptyState)
    : messageList;

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={handleUserScrollIntent}
        data-testid="message-timeline-scroll"
        className="scrollbar-none h-full overflow-y-auto"
      >
        {/* A min-height column so the sticky footer sits at the bottom even when
            the conversation is short, and floats over the messages once they
            overflow. The footer (composer) shares this scroll container, so the
            browser handles native scroll latching: a swipe parks the composer's
            text at its edge, the next swipe scrolls the conversation behind it. */}
        <div className="flex min-h-full flex-col">
          <div
            className="flex min-h-0 flex-1 flex-col"
            role="log"
            aria-label={t("timeline.ariaLabel")}
            aria-live="polite"
          >
            {content}
          </div>
          {footer ? (
            <div
              ref={footerRef}
              data-testid="message-timeline-footer"
              className="pointer-events-none sticky bottom-4 z-10 flex flex-col"
            >
              {jumpToLatestButton ? (
                <div className="mb-2 flex justify-center">
                  <div className="pointer-events-auto">
                    {jumpToLatestButton}
                  </div>
                </div>
              ) : null}
              {footer}
            </div>
          ) : null}
        </div>
      </div>
      {!footer && jumpToLatestButton ? (
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ bottom: (tailPaddingPx ?? 16) + 8 }}
        >
          {jumpToLatestButton}
        </div>
      ) : null}
    </div>
  );
}
