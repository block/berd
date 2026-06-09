import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { MessageBubble } from "./MessageBubble";
import { TranscriptSearchSkip } from "./TranscriptSearchSkip";
import { MessageTimelineScrollContainer } from "./MessageTimelineScrollContainer";
import { getTextContent, type Message } from "@/shared/types/messages";
import {
  easeOutCubic,
  JUMP_TO_LATEST_SCROLL_MS,
  MessageDateSeparator,
  MessageTimelineEmptyState,
  MessageTimelineFooterControlRow,
  MessageTimelineJumpToLatestButton,
  REDUCED_MOTION_QUERY,
  type MessageTimelineBubbleCallbacks,
} from "./messageTimelineShared";

const AUTO_SCROLL_THRESHOLD_PX = 180;
const PINNED_BOTTOM_THRESHOLD_PX = 8;
const MCP_APP_STICKY_SCROLL_MS = 1500;
// Mirrors --chat-composer-surface-overlap for scroll math; CSS owns the token.
const FOOTER_DOCK_OVERLAP_PX = 28;
const FOOTER_DOCK_CLEARANCE_PX = 32;

interface MessageTimelineProps extends MessageTimelineBubbleCallbacks {
  messages: Message[];
  streamingMessageId?: string | null;
  scrollTargetMessageId?: string | null;
  scrollTargetQuery?: string | null;
  onScrollTargetHandled?: (messageId: string) => void;
  /** Receives the element wrapping the rendered transcript content, the
      search root for find-in-transcript (useChatTranscriptSearch). */
  searchContentRef?: Ref<HTMLDivElement>;
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
  searchContentRef,
  onRetryMessage,
  onEditMessage,
  onSendMcpAppMessage,
  onRunShellCommand,
  onEditProject,
  onOpenContextPanel,
  className,
  tailPaddingPx,
  footer,
  footerStatus,
  placeholder,
  showPlaceholder,
}: MessageTimelineProps) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const containerRef = useRef<HTMLDivElement>(null);
  // The composer is docked in flow and visually overlaps the transcript; its
  // measured height changes the scrollable viewport while overlap padding keeps
  // the last message above the glass surface.
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isNearBottomRef = useRef(true);
  const isPinnedToBottomRef = useRef(true);
  const userDetachedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const stickyScrollUntilRef = useRef(0);
  const hadRealScrollableOverflowRef = useRef(false);
  const messageListBottomPaddingPxRef = useRef(0);
  const autoScrollTimersRef = useRef<number[]>([]);
  const jumpToLatestAnimationFrameRef = useRef<number | null>(null);
  const lastMcpAppSignatureRef = useRef<string | null>(null);
  const followStreamingMessageIdRef = useRef<string | null>(null);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);
  const [userDetached, setUserDetached] = useState(false);
  const [footerHeightPx, setFooterHeightPx] = useState(0);
  const hasFooter = footer != null;
  const messageListBottomPaddingPx = hasFooter
    ? FOOTER_DOCK_OVERLAP_PX + FOOTER_DOCK_CLEARANCE_PX
    : (tailPaddingPx ?? 16);
  messageListBottomPaddingPxRef.current = messageListBottomPaddingPx;
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

  const getBottomScrollTop = useCallback((container: HTMLDivElement) => {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }, []);

  const hasRealScrollableOverflow = useCallback((container: HTMLDivElement) => {
    return (
      Math.max(
        0,
        container.scrollHeight - messageListBottomPaddingPxRef.current,
      ) > container.clientHeight
    );
  }, []);

  const setTimelineScrollTop = useCallback(
    (container: HTMLDivElement, scrollTop: number) => {
      container.scrollTop = scrollTop;
      lastScrollTopRef.current = container.scrollTop;
    },
    [],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const bottomScrollTop = getBottomScrollTop(container);
      if (hasRealScrollableOverflow(container)) {
        hadRealScrollableOverflowRef.current = true;
      }

      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          top: bottomScrollTop,
          behavior,
        });
        lastScrollTopRef.current = container.scrollTop;
        return;
      }

      setTimelineScrollTop(container, bottomScrollTop);
    },
    [getBottomScrollTop, hasRealScrollableOverflow, setTimelineScrollTop],
  );

  const cancelJumpToLatestAnimation = useCallback(() => {
    if (jumpToLatestAnimationFrameRef.current == null) {
      return;
    }

    cancelAnimationFrame(jumpToLatestAnimationFrameRef.current);
    jumpToLatestAnimationFrameRef.current = null;
  }, []);

  const scrollToBottomWithControlledSmooth = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    cancelJumpToLatestAnimation();

    const startScrollTop = container.scrollTop;
    const initialBottomScrollTop = getBottomScrollTop(container);
    if (Math.abs(initialBottomScrollTop - startScrollTop) <= 1) {
      setTimelineScrollTop(container, initialBottomScrollTop);
      return;
    }

    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      setTimelineScrollTop(container, initialBottomScrollTop);
      return;
    }

    let startTime: number | null = null;
    const animate = (now: number) => {
      const nextContainer = containerRef.current;
      if (!nextContainer) {
        jumpToLatestAnimationFrameRef.current = null;
        return;
      }

      startTime ??= now;
      const progress = Math.min(
        1,
        (now - startTime) / JUMP_TO_LATEST_SCROLL_MS,
      );
      const bottomScrollTop = getBottomScrollTop(nextContainer);
      const nextScrollTop =
        startScrollTop +
        (bottomScrollTop - startScrollTop) * easeOutCubic(progress);
      setTimelineScrollTop(nextContainer, nextScrollTop);

      if (progress < 1) {
        jumpToLatestAnimationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      setTimelineScrollTop(nextContainer, bottomScrollTop);
      jumpToLatestAnimationFrameRef.current = null;
    };

    jumpToLatestAnimationFrameRef.current = requestAnimationFrame(animate);
  }, [cancelJumpToLatestAnimation, getBottomScrollTop, setTimelineScrollTop]);

  const setDetachedFromLatest = useCallback(
    (detached: boolean) => {
      // The jump-to-latest button is driven by this detached state. Only allow
      // the detached state when there is real content overflow to scroll to;
      // otherwise the docked composer's bottom padding can inflate scrollHeight
      // past clientHeight and surface the button with nothing to scroll to.
      if (detached) {
        const container = containerRef.current;
        if (!container || !hasRealScrollableOverflow(container)) {
          return;
        }
      }

      if (userDetachedRef.current === detached) {
        return;
      }

      userDetachedRef.current = detached;
      setUserDetached(detached);
    },
    [hasRealScrollableOverflow],
  );

  const syncUnscrollableState = useCallback(
    (scrollTop: number) => {
      hadRealScrollableOverflowRef.current = false;
      isNearBottomRef.current = true;
      isPinnedToBottomRef.current = true;
      lastScrollTopRef.current = scrollTop;
      userScrollIntentRef.current = false;
      setDetachedFromLatest(false);
    },
    [setDetachedFromLatest],
  );

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

  const activeStreamingMessage = streamingMessageId
    ? (visibleMessages.find((message) => message.id === streamingMessageId) ??
      null)
    : null;

  useEffect(() => {
    if (!activeStreamingMessage || userDetachedRef.current) {
      return;
    }

    if (activeStreamingMessage.role !== "assistant") {
      return;
    }

    if (followStreamingMessageIdRef.current === activeStreamingMessage.id) {
      return;
    }

    const container = containerRef.current;
    const messageEl = messageRefs.current[activeStreamingMessage.id];
    if (!container || !messageEl) {
      return;
    }

    const messageHeight = messageEl.getBoundingClientRect().height;
    const viewportHeight = container.clientHeight;

    if (messageHeight <= viewportHeight) {
      return;
    }

    const targetScrollTop = Math.max(0, messageEl.offsetTop - 16);
    isNearBottomRef.current = false;
    isPinnedToBottomRef.current = false;
    stickyScrollUntilRef.current = 0;
    setDetachedFromLatest(true);
    setTimelineScrollTop(container, targetScrollTop);
  }, [activeStreamingMessage, setDetachedFromLatest, setTimelineScrollTop]);

  // Use scrollTo instead of scrollIntoView to avoid scrolling parent/document-level ancestors.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable and don't need to be in deps
  useEffect(() => {
    scrollToBottomIfNearBottom();
  }, [messages, scrollToBottomIfNearBottom, streamingMessageId]);

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
  }, [hasFooter]);

  // When the docked footer changes height, it changes the timeline's available
  // scroll height. Only users who are already following latest should be
  // re-pinned.
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
    if (
      stickyScrollUntilRef.current <= performance.now() &&
      !hadRealScrollableOverflowRef.current
    ) {
      return;
    }
    scrollToBottom("auto");
  }, [
    footerHeightPx,
    hasFooter,
    messageListBottomPaddingPx,
    scrollToBottom,
    tailPaddingPx,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const syncScrollState = () => {
      if (container.scrollHeight <= container.clientHeight) {
        syncUnscrollableState(container.scrollTop);
        return;
      }

      lastScrollTopRef.current = container.scrollTop;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
      isPinnedToBottomRef.current =
        distanceFromBottom <= PINNED_BOTTOM_THRESHOLD_PX;
      hadRealScrollableOverflowRef.current =
        hasRealScrollableOverflow(container);

      // A resize can create scrollable overflow that leaves the user away from
      // the latest message without any scroll/wheel event firing. Reconcile the
      // detached state from the post-resize position so "Jump to latest"
      // appears (or hides) to match what the user actually sees.
      if (userDetachedRef.current) {
        if (isPinnedToBottomRef.current) {
          setDetachedFromLatest(false);
        }
        return;
      }

      if (distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX) {
        setDetachedFromLatest(true);
        stickyScrollUntilRef.current = 0;
      }
    };

    let resizeFrame: number | null = null;

    const syncAfterResize = () => {
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
    };

    const scheduleSyncAfterResize = () => {
      if (resizeFrame != null) {
        cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        syncAfterResize();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleSyncAfterResize);

    resizeObserver?.observe(container);
    // Tauri WebView viewport changes can miss element ResizeObserver delivery.
    window.addEventListener("resize", scheduleSyncAfterResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSyncAfterResize);
      if (resizeFrame != null) {
        cancelAnimationFrame(resizeFrame);
      }
    };
  }, [
    hasRealScrollableOverflow,
    scrollToBottom,
    setDetachedFromLatest,
    syncUnscrollableState,
  ]);

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
      cancelJumpToLatestAnimation();
      for (const timer of autoScrollTimersRef.current) {
        window.clearTimeout(timer);
      }
      autoScrollTimersRef.current = [];
    },
    [cancelJumpToLatestAnimation],
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

    // No scrollable overflow exists, so resize-driven reflows should not
    // mark the user as detached from the latest message.
    if (scrollHeight <= clientHeight) {
      syncUnscrollableState(scrollTop);
      return;
    }

    hadRealScrollableOverflowRef.current = hasRealScrollableOverflow(container);
    // When only the composer's bottom padding makes the transcript scrollable
    // (no real content overflow), there is nothing to jump to, so never keep
    // the user marked as detached.
    if (!hadRealScrollableOverflowRef.current) {
      syncUnscrollableState(scrollTop);
      return;
    }
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

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (container.scrollHeight <= container.clientHeight) {
      syncUnscrollableState(container.scrollTop);
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
    if (streamingMessageId) {
      followStreamingMessageIdRef.current = streamingMessageId;
    }
    setDetachedFromLatest(false);
    isNearBottomRef.current = true;
    isPinnedToBottomRef.current = true;
    scrollToBottomWithControlledSmooth();
  };

  const hasFooterStatus = footerStatus != null;
  const jumpToLatestLabel = t("timeline.jumpToLatest");
  const jumpToLatestButton = userDetached ? (
    <MessageTimelineJumpToLatestButton
      compact={hasFooterStatus}
      label={jumpToLatestLabel}
      onClick={handleJumpToLatest}
    />
  ) : null;
  const footerControlRow = footer ? (
    <MessageTimelineFooterControlRow
      footerStatus={footerStatus}
      jumpToLatestButton={jumpToLatestButton}
    />
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
              "rounded-lg transition-[background-color,box-shadow]",
              pulsingMessageId === message.id &&
                "bg-accent/25 ring-2 ring-accent/35 ring-inset",
            )}
          >
            {showDateSeparator && (
              <MessageDateSeparator
                label={formatDateSeparator(
                  message.created,
                  t("timeline.today"),
                  t("timeline.yesterday"),
                  formatDate,
                )}
              />
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
              onRunShellCommand={onRunShellCommand}
              onEditProject={onEditProject}
              onOpenContextPanel={onOpenContextPanel}
            />
          </div>
        );
      })}
    </div>
  );

  const showPlaceholderContent =
    showPlaceholder || visibleMessages.length === 0;
  const content = showPlaceholderContent ? (
    <TranscriptSearchSkip>
      {placeholder ?? <MessageTimelineEmptyState />}
    </TranscriptSearchSkip>
  ) : (
    messageList
  );

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-visible",
        className,
      )}
    >
      {hasFooter ? (
        <div
          aria-hidden="true"
          data-testid="message-timeline-surface"
          className="pointer-events-none absolute inset-x-0 top-0 bottom-[calc(var(--chat-surface-bottom-gap)*2)] rounded-md bg-card"
        />
      ) : null}
      <MessageTimelineScrollContainer
        ref={containerRef}
        hasFooter={hasFooter}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={handleUserScrollIntent}
      >
        <div className="flex min-h-full flex-col">
          <div
            ref={searchContentRef}
            className="flex min-h-0 flex-1 flex-col"
            role="log"
            aria-label={t("timeline.ariaLabel")}
            aria-live="polite"
          >
            {content}
          </div>
        </div>
      </MessageTimelineScrollContainer>
      {footer ? (
        <div
          ref={footerRef}
          data-testid="message-timeline-footer"
          className="pointer-events-none relative z-10 mt-[calc(-1*var(--chat-composer-surface-overlap))] flex shrink-0 flex-col pb-[var(--chat-surface-bottom-gap)]"
        >
          {footerControlRow}
          {footer}
        </div>
      ) : null}
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
