import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";
import { cn } from "@/shared/lib/cn";
import type { Message } from "@/shared/types/messages";
import type { ActiveSessionFeedbackSurvey } from "../response-feedback/sessionFeedbackSurveyState";
import {
  VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
  type TranscriptShellMeasurementPlan,
} from "../transcript/measurement";
import { TranscriptRowStateProvider } from "../transcript/row-state";
import type { TranscriptRowDescriptor } from "../transcript/projection";
import type { TranscriptVirtualItem } from "../transcript/virtual";
import type { TranscriptVirtualRowStateProviderConfig } from "../transcript/virtual/react/useTranscriptVirtualTimeline";
import { AgentWorkPanel } from "./AgentWorkPanel";
import { MessageBubble } from "./MessageBubble";
import {
  MessageDateSeparator,
  type MessageBubbleCallbacks,
} from "./messageTimelineShared";
import { getVirtualTranscriptRowSpacingClassName } from "./virtualTranscriptRowSpacing";

const STREAMING_ROW_ACTION_GUTTER = "0.75rem";
const EMPTY_MESSAGE_BUBBLE_CALLBACKS: MessageBubbleCallbacks = {};

interface VirtualTranscriptRowProps {
  row: TranscriptRowDescriptor;
  message?: Message;
  index: number;
  previousRowKind?: TranscriptRowDescriptor["kind"];
  dateLabel?: string;
  layoutMode?: "flow" | "virtual";
  virtualItem?: Pick<
    TranscriptVirtualItem,
    "end" | "protected" | "size" | "start" | "visible"
  >;
  offscreenMeasurementKind?: "real";
  measurementPlan?: TranscriptShellMeasurementPlan;
  isStreaming?: boolean;
  settleAgentWorkOnMount?: boolean;
  actionsAlwaysVisible?: boolean;
  showJumpToResponseStartHint?: boolean;
  feedbackSessionId?: string;
  sessionFeedbackSurvey?: ActiveSessionFeedbackSurvey;
  isPulsing?: boolean;
  rowStateProvider?: TranscriptVirtualRowStateProviderConfig;
  bubbleCallbacks?: MessageBubbleCallbacks;
  registerRowElement?: (rowId: string, element: HTMLElement | null) => void;
  measureRowElement?: (rowId: string, element: HTMLElement | null) => void;
  registerMessageElement?: (
    messageId: string,
    element: HTMLDivElement | null,
  ) => void;
}

export const VirtualTranscriptRow = memo(function VirtualTranscriptRow({
  row,
  message,
  index,
  previousRowKind,
  dateLabel,
  layoutMode = "flow",
  virtualItem,
  offscreenMeasurementKind,
  measurementPlan,
  isStreaming,
  settleAgentWorkOnMount,
  actionsAlwaysVisible,
  showJumpToResponseStartHint,
  feedbackSessionId,
  sessionFeedbackSurvey,
  isPulsing,
  rowStateProvider,
  bubbleCallbacks,
  registerRowElement,
  measureRowElement,
  registerMessageElement,
}: VirtualTranscriptRowProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const isOffscreenRealMeasurement = offscreenMeasurementKind === "real";
  const isVirtualLayout = layoutMode === "virtual" && virtualItem;
  const suppressVirtualRowSelection = Boolean(
    virtualItem?.protected && !virtualItem.visible,
  );
  const suppressRowSelection =
    suppressVirtualRowSelection || isOffscreenRealMeasurement;
  const streamingActionGutter =
    isVirtualLayout && isStreaming ? STREAMING_ROW_ACTION_GUTTER : undefined;
  const rowStyle: CSSProperties | undefined = isVirtualLayout
    ? {
        ...(isStreaming
          ? {
              boxSizing: "border-box",
              paddingLeft: STREAMING_ROW_ACTION_GUTTER,
            }
          : null),
        left: streamingActionGutter
          ? `calc(0px - ${streamingActionGutter})`
          : 0,
        position: "absolute",
        pointerEvents: suppressRowSelection ? "none" : undefined,
        right: 0,
        top: `${virtualItem.start}px`,
        userSelect: suppressRowSelection ? "none" : undefined,
        WebkitUserSelect: suppressRowSelection ? "none" : undefined,
      }
    : suppressRowSelection || isOffscreenRealMeasurement
      ? {
          pointerEvents: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }
      : undefined;
  const spacingClassName = getVirtualTranscriptRowSpacingClassName({
    row,
    index,
    previousRowKind,
    layoutMode,
  });
  const flowContainmentClassName = layoutMode === "flow" ? "flow-root" : null;
  const rowTestId = isOffscreenRealMeasurement
    ? `virtual-offscreen-real-row-${row.rowId}`
    : `virtual-transcript-row-${row.rowId}`;
  const rowDiagnostics = {
    "data-virtual-row-id": isOffscreenRealMeasurement ? undefined : row.rowId,
    "data-virtual-row-kind": row.kind,
    "data-virtual-row-message-id": isOffscreenRealMeasurement
      ? undefined
      : row.messageId,
    "data-transcript-message-id": isOffscreenRealMeasurement
      ? undefined
      : row.fragment
        ? row.fragment.messageScrollTarget
          ? row.messageId
          : undefined
        : row.messageId,
    "data-virtual-row-fragment-id": row.fragment?.fragmentId,
    "data-virtual-row-fragment-index": row.fragment?.fragmentIndex,
    "data-virtual-row-fragment-count": row.fragment?.fragmentCount,
    "data-virtual-row-fragment-role": row.fragment?.role,
    "data-virtual-row-streaming-tail": row.fragment
      ? String(row.fragment.isStreamingTail)
      : undefined,
    "data-virtual-row-render-revision": row.renderRevision,
    "data-virtual-row-height-revision": row.heightRevision,
    "data-virtual-row-layout-revision": row.layoutRevision,
    "data-virtual-row-estimated-height": row.estimatedHeight,
    "data-virtual-row-spacing-before": row.spacingBefore,
    "data-virtual-row-measurement-policy": row.measurementPolicy,
    "data-virtual-row-keepalive-priority": row.keepAlivePriority,
    "data-virtual-row-layout-policy": row.layoutPendingPolicy,
    "data-virtual-row-anchor-priority": row.anchorPriority,
    "data-virtual-row-virtual-start": virtualItem?.start,
    "data-virtual-row-virtual-size": virtualItem?.size,
    "data-virtual-row-virtual-end": virtualItem?.end,
    "data-virtual-row-offscreen-real-id":
      offscreenMeasurementKind === "real" ? row.rowId : undefined,
    "data-virtual-row-visible": virtualItem
      ? String(virtualItem.visible)
      : undefined,
    "data-virtual-row-protected": virtualItem
      ? String(virtualItem.protected)
      : undefined,
    "data-virtual-row-selectable": isOffscreenRealMeasurement
      ? "false"
      : virtualItem
        ? String(!suppressRowSelection)
        : undefined,
    "data-virtual-row-shell-status": measurementPlan?.status,
    "data-virtual-row-shell-block-count": measurementPlan?.blocks.length,
    "data-virtual-row-shell-estimated-block-size":
      measurementPlan?.estimatedBlockSize,
    "data-virtual-row-shell-reserved-block-size":
      measurementPlan?.reservedBlockSize ?? undefined,
    "data-virtual-row-shell-reasons": measurementPlan?.reasons.join(","),
  };
  const {
    onRetryMessage,
    onEditMessage,
    onJumpToResponseStart,
    onForkFromMessage,
    onJumpToResponseStartHintClose,
    onJumpToResponseStartHintDismiss,
    onSendMcpAppMessage,
    onMcpAppAutoScroll,
    onRunShellCommand,
    onEditProject,
    onChangeFolder,
    onOpenContextPanel,
  } = bubbleCallbacks ?? EMPTY_MESSAGE_BUBBLE_CALLBACKS;
  const responseStartMessageId = row.responseStartMessageId ?? row.messageId;
  const handleJumpToResponseStartForRow =
    onJumpToResponseStart && responseStartMessageId
      ? () => onJumpToResponseStart(responseStartMessageId)
      : undefined;

  const registerElement = useCallback(
    (element: HTMLDivElement | null) => {
      elementRef.current = element;
      registerRowElement?.(row.rowId, element);
      if (
        row.messageId &&
        (row.kind === "message" ||
          row.kind === "agent-work" ||
          row.fragment?.messageScrollTarget)
      ) {
        registerMessageElement?.(row.messageId, element);
      }
    },
    [
      registerMessageElement,
      registerRowElement,
      row.fragment?.messageScrollTarget,
      row.kind,
      row.messageId,
      row.rowId,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: row revisions and virtual size intentionally retrigger visible measurement.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      measureRowElement?.(row.rowId, element);
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(element, {
      attributeFilter: [
        VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
        VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
        "class",
        "style",
      ],
      attributes: true,
      childList: true,
      subtree: true,
    });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      measureRowElement?.(row.rowId, null);
    };
  }, [
    measureRowElement,
    row.heightRevision,
    row.renderRevision,
    row.rowId,
    virtualItem?.size,
  ]);
  let rowContent: ReactElement;
  if (row.kind === "date-separator") {
    rowContent = (
      <div
        ref={registerElement}
        data-testid={rowTestId}
        {...rowDiagnostics}
        style={rowStyle}
        className={cn(spacingClassName, flowContainmentClassName)}
      >
        <MessageDateSeparator label={dateLabel} />
      </div>
    );
  } else if (
    row.kind === "assistant-content-fragment" &&
    message &&
    row.fragment
  ) {
    rowContent = (
      <div
        ref={registerElement}
        data-testid={rowTestId}
        {...rowDiagnostics}
        style={rowStyle}
        className={cn(
          spacingClassName,
          flowContainmentClassName,
          "rounded-lg transition-[background-color,box-shadow]",
          isPulsing && "bg-accent/25 ring-2 ring-accent/35 ring-inset",
        )}
      >
        <MessageBubble
          message={message}
          animateEntry={false}
          contentOverride={row.fragment.content}
          actionMessageId={row.responseStartMessageId ?? row.messageId}
          fragmentRole={row.fragment.role}
          isStreaming={row.fragment.isStreamingTail && isStreaming}
          actionsAlwaysVisible={actionsAlwaysVisible}
          feedbackSessionId={feedbackSessionId}
          sessionFeedbackSurvey={sessionFeedbackSurvey}
          sessionFeedbackSurveyMeasurementOnly={isOffscreenRealMeasurement}
          showJumpToResponseStartHint={showJumpToResponseStartHint}
          onRetryMessage={
            row.fragment.role === "end" || row.fragment.role === "single"
              ? onRetryMessage
              : undefined
          }
          onJumpToResponseStart={
            message.role === "assistant" && !isStreaming
              ? handleJumpToResponseStartForRow
              : undefined
          }
          onForkFromMessage={
            (message.role === "user" || message.role === "assistant") &&
            !isStreaming
              ? onForkFromMessage
              : undefined
          }
          onJumpToResponseStartHintClose={onJumpToResponseStartHintClose}
          onJumpToResponseStartHintDismiss={onJumpToResponseStartHintDismiss}
          onSendMcpAppMessage={onSendMcpAppMessage}
          onMcpAppAutoScroll={onMcpAppAutoScroll}
          onRunShellCommand={onRunShellCommand}
          onEditProject={onEditProject}
          onChangeFolder={onChangeFolder}
          onOpenContextPanel={onOpenContextPanel}
        />
      </div>
    );
  } else if (row.kind === "agent-work" && row.agentWork) {
    rowContent = (
      <div
        ref={registerElement}
        data-testid={`virtual-transcript-row-${row.rowId}`}
        {...rowDiagnostics}
        style={rowStyle}
        className={cn(
          spacingClassName,
          "rounded-lg transition-[background-color,box-shadow]",
          isPulsing && "bg-accent/25 ring-2 ring-accent/35 ring-inset",
        )}
      >
        <AgentWorkPanel
          payload={row.agentWork}
          settleOnMount={settleAgentWorkOnMount}
        />
      </div>
    );
  } else if (row.kind !== "message" || !message) {
    rowContent = (
      <div
        ref={registerElement}
        data-testid={rowTestId}
        {...rowDiagnostics}
        data-virtual-row-unsupported="true"
        style={rowStyle}
        hidden
      />
    );
  } else {
    rowContent = (
      <div
        ref={registerElement}
        data-testid={rowTestId}
        {...rowDiagnostics}
        style={rowStyle}
        className={cn(
          spacingClassName,
          flowContainmentClassName,
          "rounded-lg transition-[background-color,box-shadow]",
          isPulsing && "bg-accent/25 ring-2 ring-accent/35 ring-inset",
        )}
      >
        <MessageBubble
          message={message}
          animateEntry={false}
          contentOverride={row.messageContent}
          contentContext={row.messageContentContext}
          actionMessageId={row.responseStartMessageId ?? row.messageId}
          isStreaming={isStreaming}
          actionsAlwaysVisible={actionsAlwaysVisible}
          feedbackSessionId={feedbackSessionId}
          sessionFeedbackSurvey={sessionFeedbackSurvey}
          sessionFeedbackSurveyMeasurementOnly={isOffscreenRealMeasurement}
          showJumpToResponseStartHint={showJumpToResponseStartHint}
          onRetryMessage={
            message.role === "assistant" ? onRetryMessage : undefined
          }
          onEditMessage={message.role === "user" ? onEditMessage : undefined}
          onJumpToResponseStart={
            message.role === "assistant" && !isStreaming
              ? handleJumpToResponseStartForRow
              : undefined
          }
          onForkFromMessage={
            (message.role === "user" || message.role === "assistant") &&
            !isStreaming
              ? onForkFromMessage
              : undefined
          }
          onJumpToResponseStartHintClose={onJumpToResponseStartHintClose}
          onJumpToResponseStartHintDismiss={onJumpToResponseStartHintDismiss}
          onSendMcpAppMessage={onSendMcpAppMessage}
          onMcpAppAutoScroll={onMcpAppAutoScroll}
          onRunShellCommand={onRunShellCommand}
          onEditProject={onEditProject}
          onChangeFolder={onChangeFolder}
          onOpenContextPanel={onOpenContextPanel}
        />
      </div>
    );
  }

  if (!rowStateProvider) {
    return rowContent;
  }

  return (
    <TranscriptRowStateProvider
      registry={rowStateProvider.registry}
      sessionId={rowStateProvider.sessionId}
      sessionEpoch={rowStateProvider.sessionEpoch}
      rowId={row.rowId}
      onRowStateChange={rowStateProvider.onRowStateChange}
      onPinScrollAnchor={rowStateProvider.onPinScrollAnchor}
    >
      {rowContent}
    </TranscriptRowStateProvider>
  );
}, areVirtualTranscriptRowPropsEqual);

function areVirtualTranscriptRowPropsEqual(
  previous: VirtualTranscriptRowProps,
  next: VirtualTranscriptRowProps,
): boolean {
  return (
    previous.row === next.row &&
    previous.message === next.message &&
    previous.index === next.index &&
    previous.previousRowKind === next.previousRowKind &&
    previous.dateLabel === next.dateLabel &&
    previous.layoutMode === next.layoutMode &&
    previous.offscreenMeasurementKind === next.offscreenMeasurementKind &&
    previous.measurementPlan === next.measurementPlan &&
    previous.isStreaming === next.isStreaming &&
    previous.settleAgentWorkOnMount === next.settleAgentWorkOnMount &&
    previous.actionsAlwaysVisible === next.actionsAlwaysVisible &&
    previous.showJumpToResponseStartHint === next.showJumpToResponseStartHint &&
    previous.feedbackSessionId === next.feedbackSessionId &&
    previous.sessionFeedbackSurvey === next.sessionFeedbackSurvey &&
    previous.isPulsing === next.isPulsing &&
    previous.rowStateProvider === next.rowStateProvider &&
    previous.bubbleCallbacks === next.bubbleCallbacks &&
    previous.registerRowElement === next.registerRowElement &&
    previous.measureRowElement === next.measureRowElement &&
    previous.registerMessageElement === next.registerMessageElement &&
    areVirtualItemsEqual(previous.virtualItem, next.virtualItem)
  );
}

function areVirtualItemsEqual(
  previous: VirtualTranscriptRowProps["virtualItem"],
  next: VirtualTranscriptRowProps["virtualItem"],
): boolean {
  if (previous === next) {
    return true;
  }

  if (!previous || !next) {
    return false;
  }

  return (
    previous.start === next.start &&
    previous.end === next.end &&
    previous.size === next.size &&
    previous.visible === next.visible &&
    previous.protected === next.protected
  );
}
