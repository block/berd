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
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IconArrowDown } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { MessageBubble } from "./MessageBubble";
import type { McpAppMessageHandler } from "./mcpAppTypes";
import { getTextContent, type Message } from "@/shared/types/messages";

const AUTO_SCROLL_THRESHOLD_PX = 180;
const PINNED_BOTTOM_THRESHOLD_PX = 8;
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
  /** Pinned to the bottom of the timeline while the conversation scrolls behind it. */
  footer?: ReactNode;
  /** Status or activity surface shown in the footer control row above the
      composer, next to Jump to latest when both are visible. */
  footerStatus?: ReactNode;
  /** Shown in place of the message list (empty state or loading skeleton)
      while keeping the scroll container and floating footer mounted, so the
      composer never remounts between empty, loading, and populated states. */
  placeholder?: ReactNode;
  /** Force the placeholder even when messages exist, e.g. while history is
      still loading. */
  showPlaceholder?: boolean;
  /** When set, the footer is portaled here (e.g. viewport-bottom dock in ChatView). */
  composerDockEl?: HTMLElement | null;
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
  footerStatus,
  placeholder,
  showPlaceholder,
  composerDockEl,
}: MessageTimelineProps) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const containerRef = useRef<HTMLDivElement>(null);
  // The composer floats above the transcript. Its measured height becomes
  // transcript padding, so the last message can scroll fully above it.
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isNearBottomRef = useRef(true);
  const isPinnedToBottomRef = useRef(true);
  const userDetachedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const stickyScrollUntilRef = useRef(0);
  const autoScrollTimersRef = useRef<number[]>([]);
  const lastMcpAppSignatureRef = useRef<string | null>(null);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);
  const [userDetached, setUserDetached] = useState(false);
  const [footerHeightPx, setFooterHeightPx] = useState(0);
  const hasFooter = footer != null;
  const messageListBottomPaddingPx = hasFooter
    ? Math.max(footerHeightPx, 112) + 32
    : (tailPaddingPx ?? 16);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: composerDockEl changes which footer node is observed.
  useLayoutEffect(() => {
    if (!hasFooter) {
      setFooterHeightPx(0);
      return;
    }

    const footerElement = footerRef.current;
    if (!footerElement) {
      return;
    }

    const updateFooterHeight = () => {
      setFooterHeightPx(
        Math.ceil(footerElement.getBoundingClientRect().height),
      );
    };

    updateFooterHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFooterHeight);
    resizeObserver.observe(footerElement);
    return () => resizeObserver.disconnect();
  }, [composerDockEl, hasFooter]);

  // When the floating footer changes height, it changes transcript padding.
  // Only users who are already following latest should be re-pinned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the padding value is the resize signal for this effect.
  useLayoutEffect(() => {
    if (!hasFooter && tailPaddingPx == null) {
      return;
    }
    if (userDetachedRef.current) {
      return;
    }
    if (
      !isPinnedToBottomRef.current &&
      stickyScrollUntilRef.current <= performance.now()
    ) {
      return;
    }
    scrollToBottom("auto");
  }, [hasFooter, messageListBottomPaddingPx, scrollToBottom, tailPaddingPx]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const syncScrollState = () => {
      lastScrollTopRef.current = container.scrollTop;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
      isPinnedToBottomRef.current =
        distanceFromBottom <= PINNED_BOTTOM_THRESHOLD_PX;
    };

    const resizeObserver = new ResizeObserver(() => {
      const wasPinnedToLatest =
        !userDetachedRef.current &&
        (isPinnedToBottomRef.current ||
          stickyScrollUntilRef.current > performance.now());

      if (wasPinnedToLatest) {
        scrollToBottom("auto");
        syncScrollState();
        return;
      }

      syncScrollState();
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [scrollToBottom]);

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
    isPinnedToBottomRef.current =
      distanceFromBottom <= PINNED_BOTTOM_THRESHOLD_PX;

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
    isPinnedToBottomRef.current = true;
    scrollToBottom("smooth");
  };

  const hasFooterStatus = footerStatus != null;
  const jumpToLatestLabel = t("timeline.jumpToLatest");
  const jumpToLatestButton = userDetached ? (
    hasFooterStatus ? (
      <Button
        type="button"
        variant="jump-to-latest"
        size="icon-sm"
        onClick={handleJumpToLatest}
        aria-label={jumpToLatestLabel}
        title={jumpToLatestLabel}
      >
        <IconArrowDown aria-hidden="true" />
      </Button>
    ) : (
      <Button
        type="button"
        variant="jump-to-latest"
        size="sm"
        onClick={handleJumpToLatest}
        leftIcon={<IconArrowDown />}
      >
        {jumpToLatestLabel}
      </Button>
    )
  ) : null;
  const footerControlRow =
    footer && (footerStatus || jumpToLatestButton) ? (
      <div className="mb-2 flex justify-center gap-2 px-4">
        {footerStatus ? (
          <div className="pointer-events-auto">{footerStatus}</div>
        ) : null}
        {jumpToLatestButton ? (
          <div className="pointer-events-auto">{jumpToLatestButton}</div>
        ) : null}
      </div>
    ) : null;

  const messageList = (
    <div
      className="mx-auto w-full max-w-[var(--chat-transcript-container-max-width)] flex-1 px-[var(--chat-transcript-inline-padding)] pt-4"
      style={{ paddingBottom: messageListBottomPaddingPx }}
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
    <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={handleUserScrollIntent}
        data-testid="message-timeline-scroll"
        className="scrollbar-none h-full overflow-y-auto"
      >
        <div className="flex min-h-full flex-col">
          <div
            className="flex min-h-0 flex-1 flex-col"
            role="log"
            aria-label={t("timeline.ariaLabel")}
            aria-live="polite"
          >
            {content}
          </div>
        </div>
      </div>
      {footer
        ? (() => {
            const footerShell = (
              <div
                ref={footerRef}
                data-testid="message-timeline-footer"
                className="pointer-events-none flex flex-col"
              >
                {footerControlRow}
                {footer}
              </div>
            );

            if (composerDockEl) {
              return createPortal(footerShell, composerDockEl);
            }

            return (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col">
                {footerShell}
              </div>
            );
          })()
        : null}
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
