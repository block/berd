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
import { TranscriptSearchSkip } from "./TranscriptSearchSkip";
import { MessageTimelineScrollContainer } from "./MessageTimelineScrollContainer";
import { selectResponseFeedbackRowIds } from "../response-feedback/responseFeedbackRows";
import type { Message } from "@/shared/types/messages";
import type { ActiveSessionFeedbackSurvey } from "../response-feedback/sessionFeedbackSurveyState";
import {
  createTranscriptProjectionCache,
  toDateBucket,
  type TranscriptRowDescriptor,
} from "@/features/chat/transcript/projection";
import { useResponseStartGutterPreference } from "@/features/chat/lib/responseStartGutterPreference";
import { VirtualTranscriptRow } from "./VirtualTranscriptRow";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  hasAssistiveMomentBeenShown,
  recordAssistiveMomentAccepted,
  recordAssistiveMomentRetired,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import {
  easeOutCubic,
  JUMP_TO_LATEST_SCROLL_MS,
  MessageTimelineEmptyState,
  MessageTimelineFooterControlRow,
  MessageTimelineJumpToLatestButton,
  MessageTimelineJumpToResponseStartGutterButton,
  REDUCED_MOTION_QUERY,
  RESPONSE_START_HINT_HIDE_DELAY_MS,
  getTimelineMessageIdentity,
  getVoiceSubmissionKey,
  isResponseStartHintInRelevanceBand,
  useStickyFlag,
  type MessageBubbleCallbacks,
  type MessageTimelineBubbleCallbacks,
} from "./messageTimelineShared";
import {
  getTimelineBottomScrollTop,
  getTimelineDistanceFromBottom,
  hasTimelineRealScrollableOverflow,
  isTimelineNearLatest,
  isTimelinePinnedToLatest,
  shouldResumeTimelineFollowFromUserScroll,
  shouldShowTimelineJumpToLatest,
  TIMELINE_AUTO_SCROLL_THRESHOLD_PX,
  TIMELINE_MCP_APP_STICKY_SCROLL_MS,
  type TimelineScrollIntent,
} from "./timelineScrollIntent";

const FOOTER_DOCK_CLEARANCE_PX = 32;
const RESPONSE_START_HINT_VIEWPORT_SLOP_PX = 16;
// How far an assistant message's top must scroll above the viewport edge
// before the floating gutter chevron offers to jump back to its start.
const GUTTER_RESPONSE_START_THRESHOLD_PX = 16;

interface MessageTimelineProps extends MessageTimelineBubbleCallbacks {
  messages: Message[];
  feedbackSessionId?: string;
  sessionFeedbackSurvey?: ActiveSessionFeedbackSurvey | null;
  streamingMessageId?: string | null;
  scrollTargetMessageId?: string | null;
  scrollTargetQuery?: string | null;
  onScrollTargetHandled?: (messageId: string) => void;
  /** Receives the element wrapping the rendered transcript content, the
      search root for find-in-transcript (useChatTranscriptSearch). */
  searchContentRef?: Ref<HTMLDivElement>;
  className?: string;
  tailPaddingPx?: number;
  /** Owning-surface content shown before the first transcript row. */
  startContent?: ReactNode;
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

function formatRowDateSeparator(
  row: TranscriptRowDescriptor,
  labels: {
    today: string;
    yesterday: string;
    formatDate: (
      value: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ) => string;
  },
): string {
  const date = row.date;
  if (!date) return "";
  if (date.labelKey === "today") return labels.today;
  if (date.labelKey === "yesterday") return labels.yesterday;
  return labels.formatDate(date.timestamp, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function MessageTimeline({
  messages,
  feedbackSessionId,
  sessionFeedbackSurvey,
  streamingMessageId,
  scrollTargetMessageId,
  scrollTargetQuery,
  onScrollTargetHandled,
  searchContentRef,
  onRetryMessage,
  onEditMessage,
  onForkFromMessage,
  onSendMcpAppMessage,
  onRunShellCommand,
  onEditProject,
  onChangeFolder,
  onOpenContextPanel,
  className,
  tailPaddingPx,
  startContent,
  footer,
  footerStatus,
  placeholder,
  showPlaceholder,
}: MessageTimelineProps) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const responseStartGutterPreference = useResponseStartGutterPreference();
  const containerRef = useRef<HTMLDivElement>(null);
  // The composer is docked in flow at the bottom of the chat panel; its
  // measured height changes the scrollable viewport while clearance padding
  // keeps the last message from pressing into the composer.
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const projectionCacheRef = useRef(createTranscriptProjectionCache());
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
  const suppressFollowResumeFromProgrammaticScrollRef = useRef(false);
  const scrollIntentRef = useRef<TimelineScrollIntent>("following-latest");
  const previousStreamingMessageIdRef = useRef<string | null>(null);
  const previousLatestAssistantCompletionStatusRef = useRef<string | null>(
    null,
  );
  const previousLatestCompletedAssistantMessageIdRef = useRef<string | null>(
    null,
  );
  const hasInitializedResponseStartHintRef = useRef(false);
  const responseStartHintCandidateMessageIdRef = useRef<string | null>(null);
  const responseStartHintAnimationFrameRef = useRef<number | null>(null);
  const responseStartHintSeenMessageIdsRef = useRef(new Set<string>());
  const responseStartHintRecordedMessageIdRef = useRef<string | null>(null);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // The assistant message whose top has scrolled above the viewport — i.e. the
  // long reply the reader is currently scrolled inside. Drives the floating
  // gutter chevron that jumps back to that message's start.
  const [gutterResponseStartMessageId, setGutterResponseStartMessageId] =
    useState<string | null>(null);
  const [responseStartHintMessageId, setResponseStartHintMessageId] = useState<
    string | null
  >(null);
  const [responseStartHintInZone, setResponseStartHintInZone] = useState(false);
  const [footerHeightPx, setFooterHeightPx] = useState(0);
  const hasFooter = footer != null;
  const messageListBottomPaddingPx = hasFooter
    ? FOOTER_DOCK_CLEARANCE_PX
    : (tailPaddingPx ?? 16);
  messageListBottomPaddingPxRef.current = messageListBottomPaddingPx;
  const nowBucket = toDateBucket(Date.now());
  const localeKey = "default";
  const snapshot = useMemo(
    () =>
      projectionCacheRef.current.update({
        sessionId: "legacy-message-timeline",
        sessionEpoch: 1,
        messages,
        streamingMessageId: streamingMessageId ?? null,
        nowBucket,
        localeKey,
      }),
    [messages, nowBucket, streamingMessageId],
  );
  const responseFeedbackRowIds = useMemo(
    () => selectResponseFeedbackRowIds(snapshot.rows),
    [snapshot.rows],
  );
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.metadata?.userVisible !== false &&
          snapshot.rowByMessageId.has(m.id),
      ),
    [messages, snapshot.rowByMessageId],
  );
  const resolvedScrollTargetMessageId = useMemo(() => {
    if (
      scrollTargetMessageId &&
      snapshot.rowByMessageId.has(scrollTargetMessageId)
    ) {
      return scrollTargetMessageId;
    }

    const trimmedQuery = scrollTargetQuery?.trim().toLocaleLowerCase();
    if (!trimmedQuery) {
      return null;
    }

    for (const [
      messageId,
      searchableText,
    ] of snapshot.searchableTextByMessageId) {
      if (searchableText.toLocaleLowerCase().includes(trimmedQuery)) {
        return messageId;
      }
    }

    return null;
  }, [scrollTargetMessageId, scrollTargetQuery, snapshot]);

  const getBottomScrollTop = useCallback(
    (container: HTMLDivElement) => getTimelineBottomScrollTop(container),
    [],
  );

  const hasRealScrollableOverflow = useCallback((container: HTMLDivElement) => {
    return hasTimelineRealScrollableOverflow({
      metrics: container,
      bottomPaddingPx: messageListBottomPaddingPxRef.current,
    });
  }, []);

  const syncJumpToLatestVisibility = useCallback(
    (intent: TimelineScrollIntent = scrollIntentRef.current) => {
      const container = containerRef.current;
      if (!container) {
        setShowJumpToLatest(false);
        return;
      }

      setShowJumpToLatest(
        shouldShowTimelineJumpToLatest({
          intent,
          metrics: container,
          bottomPaddingPx: messageListBottomPaddingPxRef.current,
        }),
      );
    },
    [],
  );

  const latestAssistantMessage = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index];
      if (message?.role === "assistant") {
        return message;
      }
    }
    return null;
  }, [visibleMessages]);
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;

  // Decide which assistant message the floating gutter chevron should jump to.
  // The chevron floats near the bottom of the transcript (just above the
  // composer), so it must refer to the message sitting *at that bottom anchor
  // line* (not the topmost one), or it would point at a message far above where
  // it's drawn. We only offer the jump once that message's top has scrolled
  // above the container's top edge, so there is genuinely somewhere to jump
  // back to.
  const syncGutterResponseStartVisibility = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      setGutterResponseStartMessageId(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    // Anchor at the visible bottom edge, lifted above the composer padding so
    // it targets the message row the reader is actually finishing. The button is
    // drawn a little higher than this line (see GUTTER_RESPONSE_START_LIFT_RATIO
    // in the shared component), but the target stays bottom-anchored.
    const anchorY =
      containerRect.bottom -
      messageListBottomPaddingPxRef.current -
      GUTTER_RESPONSE_START_THRESHOLD_PX;
    let candidateId: string | null = null;

    for (let index = snapshot.rows.length - 1; index >= 0; index -= 1) {
      const row = snapshot.rows[index];
      if (!row?.messageId) {
        continue;
      }
      const message = snapshot.messageById.get(row.messageId);
      if (message?.role !== "assistant") {
        continue;
      }
      const responseStartMessageId =
        row.responseStartMessageId ?? row.messageId;
      if (responseStartMessageId === streamingMessageId) {
        continue;
      }
      const rowElement = rowRefs.current[row.rowId];
      if (!rowElement) {
        continue;
      }
      const rowRect = rowElement.getBoundingClientRect();
      const coversAnchor = rowRect.top <= anchorY && rowRect.bottom > anchorY;
      if (!coversAnchor) {
        continue;
      }

      const responseStartElement = messageRefs.current[responseStartMessageId];
      if (!responseStartElement) {
        continue;
      }
      const responseStartRect = responseStartElement.getBoundingClientRect();
      const topAboveViewport =
        responseStartRect.top <
        containerRect.top - GUTTER_RESPONSE_START_THRESHOLD_PX;
      if (topAboveViewport) {
        candidateId = responseStartMessageId;
        break;
      }
    }
    setGutterResponseStartMessageId(candidateId);
  }, [snapshot.messageById, snapshot.rows, streamingMessageId]);

  useLayoutEffect(() => {
    syncGutterResponseStartVisibility();
  }, [syncGutterResponseStartVisibility]);

  // Live relevance gate for the per-message jump-to-response-start hint. The
  // hint popover anchors to the action chevron at the bottom of the message's
  // final row, so it should only be visible while that chevron sits inside the
  // active reading band — below a generous top margin (so a chevron parked
  // near/above the top no longer counts as "being read") and above the composer
  // overlay. This single position check subsumes every off-zone case: scrolled
  // above the top, parked near the top, and pushed below the composer all fail
  // it. `wasActive` carries the previous gate state so the top boundary can
  // apply hysteresis and avoid restarting the hint's fade on scroll jitter.
  const computeResponseStartHintActive = useCallback(
    (messageId: string | null, wasActive: boolean) => {
      if (!messageId) {
        return false;
      }
      const container = containerRef.current;
      if (!container) {
        return false;
      }
      let chevronRowElement: HTMLElement | null = null;
      for (let index = snapshot.rows.length - 1; index >= 0; index -= 1) {
        const row = snapshot.rows[index];
        if (row?.messageId === messageId) {
          chevronRowElement = rowRefs.current[row.rowId] ?? null;
          break;
        }
      }
      if (!chevronRowElement) {
        return false;
      }

      const containerRect = container.getBoundingClientRect();
      const chevronRect = chevronRowElement.getBoundingClientRect();
      const footerRect = footerRef.current?.getBoundingClientRect();
      const visibleBottom = footerRect
        ? Math.min(containerRect.bottom, footerRect.top)
        : containerRect.bottom;
      // Absolute viewport coordinates: the container's top edge is the origin
      // and the chevron renders at the bottom of the message's final row.
      return isResponseStartHintInRelevanceBand({
        chevronY: chevronRect.bottom,
        containerTop: containerRect.top,
        visibleBottom,
        wasActive,
      });
    },
    [snapshot.rows],
  );

  useLayoutEffect(() => {
    setResponseStartHintInZone((wasInZone) =>
      computeResponseStartHintActive(responseStartHintMessageId, wasInZone),
    );
  }, [computeResponseStartHintActive, responseStartHintMessageId]);

  // Show the hint as soon as its chevron enters the band, but hold it briefly
  // after the gate drops so a scroll that sweeps the chevron out (or jitters at
  // an edge) doesn't tear the popover down mid-fade and restart it.
  const responseStartHintActive = useStickyFlag(
    responseStartHintInZone,
    RESPONSE_START_HINT_HIDE_DELAY_MS,
  );

  // Record the "shown" count the first time the hint is actually visible for a
  // message, not when it was merely scheduled. With maxShows = 1, recording at
  // schedule time could retire the moment as expired for a hint the user never
  // saw (e.g. the visibility band never opened before they switched sessions).
  useEffect(() => {
    if (
      responseStartHintMessageId &&
      responseStartHintActive &&
      responseStartHintRecordedMessageIdRef.current !==
        responseStartHintMessageId
    ) {
      responseStartHintRecordedMessageIdRef.current =
        responseStartHintMessageId;
      recordAssistiveMomentShown(ASSISTIVE_UX_RULES.chatJumpToResponseStart.id);
    }
  }, [responseStartHintMessageId, responseStartHintActive]);

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

  const clearProgrammaticFollowResumeSuppression = useCallback(() => {
    suppressFollowResumeFromProgrammaticScrollRef.current = false;
  }, []);

  const scrollToTargetWithControlledSmooth = useCallback(
    (
      targetScrollTop: number,
      { suppressFollowResume = false }: { suppressFollowResume?: boolean } = {},
    ) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      cancelJumpToLatestAnimation();
      if (suppressFollowResume) {
        suppressFollowResumeFromProgrammaticScrollRef.current = true;
      }

      const startScrollTop = container.scrollTop;
      if (
        Math.abs(targetScrollTop - startScrollTop) <= 1 ||
        window.matchMedia(REDUCED_MOTION_QUERY).matches
      ) {
        setTimelineScrollTop(container, targetScrollTop);
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
        const nextScrollTop =
          startScrollTop +
          (targetScrollTop - startScrollTop) * easeOutCubic(progress);
        setTimelineScrollTop(nextContainer, nextScrollTop);

        if (progress < 1) {
          jumpToLatestAnimationFrameRef.current =
            requestAnimationFrame(animate);
          return;
        }

        setTimelineScrollTop(nextContainer, targetScrollTop);
        jumpToLatestAnimationFrameRef.current = null;
      };

      jumpToLatestAnimationFrameRef.current = requestAnimationFrame(animate);
    },
    [cancelJumpToLatestAnimation, setTimelineScrollTop],
  );

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

  const isResponseStartHintEligible = useCallback((messageId: string) => {
    const container = containerRef.current;
    const target = messageRefs.current[messageId];
    if (!container || !target) {
      return false;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const footerRect = footerRef.current?.getBoundingClientRect();
    const visibleBottom = footerRect
      ? Math.min(containerRect.bottom, footerRect.top)
      : containerRect.bottom;
    const visibleHeight = Math.max(0, visibleBottom - containerRect.top);

    return (
      targetRect.height >
        visibleHeight - RESPONSE_START_HINT_VIEWPORT_SLOP_PX ||
      targetRect.top < containerRect.top + RESPONSE_START_HINT_VIEWPORT_SLOP_PX
    );
  }, []);

  const setDetachedFromLatest = useCallback(
    (
      detached: boolean,
      intent: TimelineScrollIntent = detached
        ? "user-detached"
        : "following-latest",
    ) => {
      if (detached) {
        const container = containerRef.current;
        if (!container || !hasRealScrollableOverflow(container)) {
          syncJumpToLatestVisibility("following-latest");
          return;
        }
      }

      scrollIntentRef.current = intent;
      syncJumpToLatestVisibility(intent);

      if (userDetachedRef.current === detached) {
        return;
      }

      userDetachedRef.current = detached;
    },
    [hasRealScrollableOverflow, syncJumpToLatestVisibility],
  );

  const syncUnscrollableState = useCallback(
    (scrollTop: number) => {
      hadRealScrollableOverflowRef.current = false;
      isNearBottomRef.current = true;
      isPinnedToBottomRef.current = true;
      lastScrollTopRef.current = scrollTop;
      userScrollIntentRef.current = false;
      setDetachedFromLatest(false);
      setGutterResponseStartMessageId(null);
    },
    [setDetachedFromLatest],
  );

  const scrollToBottomIfNearBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      if (
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current
      ) {
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const stickyActive = stickyScrollUntilRef.current > performance.now();

      if (
        !isNearBottomRef.current &&
        !stickyActive &&
        distanceFromBottom >= TIMELINE_AUTO_SCROLL_THRESHOLD_PX
      ) {
        return;
      }

      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  const schedulePinnedBottomBurst = useCallback(() => {
    if (
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
      return;
    }

    stickyScrollUntilRef.current =
      performance.now() + TIMELINE_MCP_APP_STICKY_SCROLL_MS;

    for (const timer of autoScrollTimersRef.current) {
      window.clearTimeout(timer);
    }
    autoScrollTimersRef.current = [];

    const run = () => {
      if (
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current
      ) {
        return;
      }
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

    if (
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const shouldStick =
      isNearBottomRef.current ||
      distanceFromBottom < TIMELINE_AUTO_SCROLL_THRESHOLD_PX ||
      stickyScrollUntilRef.current > performance.now();

    if (!shouldStick) {
      return;
    }

    stickyScrollUntilRef.current =
      performance.now() + TIMELINE_MCP_APP_STICKY_SCROLL_MS;

    const alignElementBottom = () => {
      const nextContainer = containerRef.current;
      if (!nextContainer || !element.isConnected) {
        return;
      }
      if (
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current
      ) {
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
    if (
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
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
      const distanceFromBottom = getTimelineDistanceFromBottom(container);
      isNearBottomRef.current = isTimelineNearLatest(container);
      isPinnedToBottomRef.current = isTimelinePinnedToLatest(container);
      hadRealScrollableOverflowRef.current =
        hasRealScrollableOverflow(container);

      // A resize can create scrollable overflow that leaves the user away from
      // the latest message without any scroll/wheel event firing. Reconcile the
      // detached state from the post-resize position so "Jump to latest"
      // appears (or hides) to match what the user actually sees.
      if (userDetachedRef.current) {
        if (
          isPinnedToBottomRef.current &&
          !suppressFollowResumeFromProgrammaticScrollRef.current
        ) {
          setDetachedFromLatest(false);
        } else {
          syncJumpToLatestVisibility();
        }
        return;
      }

      if (distanceFromBottom >= TIMELINE_AUTO_SCROLL_THRESHOLD_PX) {
        setDetachedFromLatest(true);
        stickyScrollUntilRef.current = 0;
      } else {
        syncJumpToLatestVisibility();
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
    syncJumpToLatestVisibility,
    syncUnscrollableState,
  ]);

  const latestVisibleMessage = visibleMessages.at(-1);
  const latestVisibleMessageId = latestVisibleMessage?.id;
  const visibleMessageIdentities = useMemo(
    () => visibleMessages.map(getTimelineMessageIdentity),
    [visibleMessages],
  );
  const visibleVoiceSubmissionKeys = useMemo(
    () =>
      visibleMessages
        .map(getVoiceSubmissionKey)
        .filter((key): key is string => key !== null),
    [visibleMessages],
  );
  const seenVoiceSubmissionKeysRef = useRef(
    new Set(visibleVoiceSubmissionKeys),
  );
  const previousVisibleTailIdentityRef = useRef(
    visibleMessageIdentities.at(-1),
  );

  useEffect(() => {
    if (
      !latestVisibleMessageId ||
      latestVisibleMessage?.role !== "user" ||
      latestVisibleMessage.metadata?.origin === "voice_conversation"
    ) {
      return;
    }

    clearProgrammaticFollowResumeSuppression();
    setDetachedFromLatest(false);
    scrollToBottom("auto");
  }, [
    clearProgrammaticFollowResumeSuppression,
    latestVisibleMessageId,
    latestVisibleMessage?.metadata?.origin,
    latestVisibleMessage?.role,
    scrollToBottom,
    setDetachedFromLatest,
  ]);

  useEffect(() => {
    let latestUnseenVoiceSubmissionIndex = -1;
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const key = getVoiceSubmissionKey(visibleMessages[index]);
      if (key && !seenVoiceSubmissionKeysRef.current.has(key)) {
        latestUnseenVoiceSubmissionIndex = index;
      }
    }
    const previousTailIdentity = previousVisibleTailIdentityRef.current;
    const previousTailIndex = previousTailIdentity
      ? visibleMessageIdentities.indexOf(previousTailIdentity)
      : -1;
    for (const key of visibleVoiceSubmissionKeys) {
      seenVoiceSubmissionKeysRef.current.add(key);
    }
    previousVisibleTailIdentityRef.current = visibleMessageIdentities.at(-1);
    if (
      latestUnseenVoiceSubmissionIndex < 0 ||
      (previousTailIdentity &&
        (previousTailIndex < 0 ||
          latestUnseenVoiceSubmissionIndex <= previousTailIndex))
    ) {
      return;
    }
    clearProgrammaticFollowResumeSuppression();
    setDetachedFromLatest(false);
    schedulePinnedBottomBurst();
  }, [
    clearProgrammaticFollowResumeSuppression,
    schedulePinnedBottomBurst,
    setDetachedFromLatest,
    visibleMessageIdentities,
    visibleMessages,
    visibleVoiceSubmissionKeys,
  ]);

  const scheduleResponseStartHint = useCallback(
    (messageId: string) => {
      if (responseStartHintAnimationFrameRef.current != null) {
        cancelAnimationFrame(responseStartHintAnimationFrameRef.current);
      }

      responseStartHintAnimationFrameRef.current = requestAnimationFrame(() => {
        responseStartHintAnimationFrameRef.current = null;

        if (responseStartHintSeenMessageIdsRef.current.has(messageId)) {
          responseStartHintCandidateMessageIdRef.current = null;
          return;
        }

        const completedMessage = visibleMessages.find(
          (message) => message.id === messageId,
        );
        const rejectionReason = !completedMessage
          ? "missing-message"
          : completedMessage.role !== "assistant"
            ? "not-assistant"
            : completedMessage.id !== latestAssistantMessageId
              ? "not-latest-assistant"
              : completedMessage.metadata?.completionStatus === "inProgress" &&
                  completedMessage.id === streamingMessageId
                ? "still-in-progress"
                : !shouldShowAssistiveMoment(
                      ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
                    )
                  ? "assistive-ux-not-eligible"
                  : !isResponseStartHintEligible(completedMessage.id)
                    ? "response-start-not-eligible"
                    : null;
        if (rejectionReason) {
          if (completedMessage) {
            responseStartHintCandidateMessageIdRef.current = null;
          }
          return;
        }
        if (!completedMessage) {
          return;
        }

        responseStartHintSeenMessageIdsRef.current.add(completedMessage.id);
        responseStartHintCandidateMessageIdRef.current = null;
        // Select the candidate here, but defer recording the "shown" count
        // until the hint actually becomes visible (see the effect that watches
        // responseStartHintActive). Counting at schedule time could spend the
        // single allowed show on a hint the user never saw if the visibility
        // band never opens before they move on.
        setResponseStartHintMessageId(completedMessage.id);
      });
    },
    [
      isResponseStartHintEligible,
      latestAssistantMessageId,
      streamingMessageId,
      visibleMessages,
    ],
  );

  useLayoutEffect(() => {
    const latestAssistantCompletionStatus =
      latestAssistantMessage?.metadata?.completionStatus ?? null;
    const previousLatestAssistantCompletionStatus =
      previousLatestAssistantCompletionStatusRef.current;
    previousLatestAssistantCompletionStatusRef.current =
      latestAssistantCompletionStatus;
    const latestCompletedAssistantMessageId =
      latestAssistantMessage?.id &&
      latestAssistantMessage.id !== streamingMessageId
        ? latestAssistantMessage.id
        : null;
    const previousLatestCompletedAssistantMessageId =
      previousLatestCompletedAssistantMessageIdRef.current;
    previousLatestCompletedAssistantMessageIdRef.current =
      latestCompletedAssistantMessageId;
    const hasInitializedResponseStartHint =
      hasInitializedResponseStartHintRef.current;
    hasInitializedResponseStartHintRef.current = true;

    if (streamingMessageId) {
      previousStreamingMessageIdRef.current = streamingMessageId;
      responseStartHintCandidateMessageIdRef.current = streamingMessageId;
      return;
    }

    if (
      latestAssistantMessage?.id &&
      latestAssistantCompletionStatus === "inProgress" &&
      latestAssistantMessage.id === streamingMessageId
    ) {
      responseStartHintCandidateMessageIdRef.current =
        latestAssistantMessage.id;
      return;
    }

    const completedCandidateMessageId =
      previousStreamingMessageIdRef.current ??
      (previousLatestAssistantCompletionStatus === "inProgress"
        ? latestAssistantMessage?.id
        : null) ??
      responseStartHintCandidateMessageIdRef.current ??
      (hasInitializedResponseStartHint &&
      latestCompletedAssistantMessageId &&
      latestCompletedAssistantMessageId !==
        previousLatestCompletedAssistantMessageId
        ? latestCompletedAssistantMessageId
        : null);
    previousStreamingMessageIdRef.current = null;

    if (!completedCandidateMessageId) {
      return;
    }

    scheduleResponseStartHint(completedCandidateMessageId);
  }, [
    latestAssistantMessage?.id,
    latestAssistantMessage?.metadata?.completionStatus,
    scheduleResponseStartHint,
    streamingMessageId,
  ]);

  useEffect(() => {
    return () => {
      if (responseStartHintAnimationFrameRef.current != null) {
        cancelAnimationFrame(responseStartHintAnimationFrameRef.current);
      }
    };
  }, []);

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
    isNearBottomRef.current = isTimelineNearLatest(container);
    isPinnedToBottomRef.current = isTimelinePinnedToLatest(container);

    const shouldResumeFollowing =
      !suppressFollowResumeFromProgrammaticScrollRef.current &&
      shouldResumeTimelineFollowFromUserScroll({
        hasUserScrollIntent: userScrollIntentRef.current,
        isNearLatest: isNearBottomRef.current,
        isPinnedToLatest: isPinnedToBottomRef.current,
        isStreaming: Boolean(streamingMessageId),
        scrollingTowardLatest: scrollTop > lastScrollTopRef.current,
      });

    if (shouldResumeFollowing) {
      setDetachedFromLatest(false);
      if (streamingMessageId && !isPinnedToBottomRef.current) {
        scrollToBottom("auto");
        isNearBottomRef.current = true;
        isPinnedToBottomRef.current = true;
      }
    } else if (
      userScrollIntentRef.current ||
      scrollTop < lastScrollTopRef.current
    ) {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    } else {
      syncJumpToLatestVisibility();
    }
    lastScrollTopRef.current = scrollTop;
    userScrollIntentRef.current = false;
    syncGutterResponseStartVisibility();
    setResponseStartHintInZone((wasInZone) =>
      computeResponseStartHintActive(responseStartHintMessageId, wasInZone),
    );
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
    clearProgrammaticFollowResumeSuppression();

    if (event.deltaY < 0) {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    }
  };

  const handleUserScrollIntent = (event: SyntheticEvent) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }
    clearProgrammaticFollowResumeSuppression();
    userScrollIntentRef.current = true;
  };

  const handleJumpToLatest = () => {
    clearProgrammaticFollowResumeSuppression();
    setDetachedFromLatest(false);
    isNearBottomRef.current = true;
    isPinnedToBottomRef.current = true;
    scrollToBottomWithControlledSmooth();
  };

  const handleJumpToResponseStart = useCallback(
    (messageId: string) => {
      const container = containerRef.current;
      const target = messageRefs.current[messageId];
      if (!container || !target) {
        return;
      }

      cancelJumpToLatestAnimation();
      responseStartHintSeenMessageIdsRef.current.add(messageId);
      if (
        responseStartHintMessageId === messageId &&
        hasAssistiveMomentBeenShown(
          ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
        )
      ) {
        recordAssistiveMomentAccepted(
          ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
        );
      }
      setResponseStartHintMessageId((current) =>
        current === messageId ? null : current,
      );
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
      isNearBottomRef.current = false;
      isPinnedToBottomRef.current = false;

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetScrollTop = Math.max(
        0,
        container.scrollTop + targetRect.top - containerRect.top - 16,
      );
      scrollToTargetWithControlledSmooth(targetScrollTop, {
        suppressFollowResume: true,
      });
    },
    [
      cancelJumpToLatestAnimation,
      responseStartHintMessageId,
      scrollToTargetWithControlledSmooth,
      setDetachedFromLatest,
    ],
  );

  const handleResponseStartHintClose = useCallback((messageId: string) => {
    responseStartHintSeenMessageIdsRef.current.add(messageId);
    setResponseStartHintMessageId((current) =>
      current === messageId ? null : current,
    );
  }, []);

  const handleResponseStartHintDismiss = useCallback((messageId: string) => {
    responseStartHintSeenMessageIdsRef.current.add(messageId);
    recordAssistiveMomentRetired(
      ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
      "dismissed",
    );
    setResponseStartHintMessageId((current) =>
      current === messageId ? null : current,
    );
  }, []);

  const registerRowElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      rowRefs.current[rowId] = element;
    },
    [],
  );
  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      messageRefs.current[messageId] = element;
    },
    [],
  );
  const bubbleCallbacks = useMemo<MessageBubbleCallbacks>(
    () => ({
      onRetryMessage,
      onEditMessage,
      onForkFromMessage,
      onSendMcpAppMessage,
      onMcpAppAutoScroll: requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onChangeFolder,
      onOpenContextPanel,
      onJumpToResponseStart: handleJumpToResponseStart,
      onJumpToResponseStartHintClose: handleResponseStartHintClose,
      onJumpToResponseStartHintDismiss: handleResponseStartHintDismiss,
    }),
    [
      onRetryMessage,
      onEditMessage,
      onForkFromMessage,
      onSendMcpAppMessage,
      requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onChangeFolder,
      onOpenContextPanel,
      handleJumpToResponseStart,
      handleResponseStartHintClose,
      handleResponseStartHintDismiss,
    ],
  );

  const hasFooterStatus = footerStatus != null;
  const jumpToLatestLabel = t("timeline.jumpToLatest");
  const jumpToResponseStartLabel = t("message.jumpToResponseStart");
  const jumpToFloatingResponseStartLabel = t(
    "message.jumpToFloatingResponseStart",
  );
  const jumpToLatestButton = (
    <MessageTimelineJumpToLatestButton
      compact={hasFooterStatus}
      label={jumpToLatestLabel}
      onClick={handleJumpToLatest}
      visible={showJumpToLatest}
    />
  );
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
      {startContent}
      {snapshot.rows.map((row, index) => (
        <VirtualTranscriptRow
          key={row.reactKey}
          row={row}
          index={index}
          previousRowKind={snapshot.rows[index - 1]?.kind}
          dateLabel={formatRowDateSeparator(row, {
            today: t("timeline.today"),
            yesterday: t("timeline.yesterday"),
            formatDate,
          })}
          message={
            row.messageId ? snapshot.messageById.get(row.messageId) : undefined
          }
          isStreaming={
            streamingMessageId != null &&
            (row.responseStartMessageId ?? row.messageId) === streamingMessageId
          }
          actionsAlwaysVisible={
            row.messageId === latestAssistantMessageId &&
            (row.responseStartMessageId ?? row.messageId) !== streamingMessageId
          }
          feedbackSessionId={
            responseFeedbackRowIds.has(row.rowId)
              ? feedbackSessionId
              : undefined
          }
          sessionFeedbackSurvey={
            sessionFeedbackSurvey &&
            responseFeedbackRowIds.has(row.rowId) &&
            (row.responseStartMessageId ?? row.messageId) ===
              sessionFeedbackSurvey.messageId
              ? sessionFeedbackSurvey
              : undefined
          }
          showJumpToResponseStartHint={
            row.messageId === responseStartHintMessageId &&
            responseStartHintActive
          }
          isPulsing={row.messageId === pulsingMessageId}
          bubbleCallbacks={bubbleCallbacks}
          registerRowElement={registerRowElement}
          registerMessageElement={registerMessageElement}
        />
      ))}
    </div>
  );

  const showPlaceholderContent = showPlaceholder || snapshot.rows.length === 0;
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
          className="pointer-events-none relative z-10 flex shrink-0 flex-col pb-[var(--chat-surface-bottom-gap)]"
        >
          {footerControlRow}
          {footer}
        </div>
      ) : null}
      {!footer ? (
        <div
          className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 gap-2"
          style={{ bottom: (tailPaddingPx ?? 16) + 8 }}
        >
          {jumpToLatestButton}
        </div>
      ) : null}
      {responseStartGutterPreference.enabled ? (
        <MessageTimelineJumpToResponseStartGutterButton
          label={jumpToResponseStartLabel}
          ariaLabel={jumpToFloatingResponseStartLabel}
          bottomOffsetPx={
            footer ? footerHeightPx + 8 : (tailPaddingPx ?? 16) + 8
          }
          visible={gutterResponseStartMessageId != null}
          messageId={gutterResponseStartMessageId}
          onJump={handleJumpToResponseStart}
        />
      ) : null}
    </div>
  );
}
