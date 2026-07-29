import { classifyTranscriptMeasurementPolicy } from "../measurement";
import type { MessageContent } from "@/shared/types/messages";
import type {
  TranscriptAgentWorkPayload,
  TranscriptItemDescriptor,
  TranscriptRowCapabilities,
  TranscriptRowDescriptor,
} from "./transcriptItemTypes";

const TRANSCRIPT_ROW_TOP_SPACING_PX = 16;
const TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX = 24;
const TRANSCRIPT_ZERO_LAYOUT_REVISION = "layout-spacing:0";

const rowDescriptorByItem = new WeakMap<
  TranscriptItemDescriptor,
  {
    generation: number;
    row: TranscriptRowDescriptor;
  }
>();
let rowDescriptorCacheGeneration = 0;

export function invalidateTranscriptRowDescriptorCache(): void {
  rowDescriptorCacheGeneration += 1;
}

export function buildTranscriptRows(
  items: readonly TranscriptItemDescriptor[],
): readonly TranscriptRowDescriptor[] {
  const rows = items.map((item) => {
    const cachedRow = rowDescriptorByItem.get(item);
    if (cachedRow?.generation === rowDescriptorCacheGeneration) {
      return cachedRow.row;
    }

    let row: TranscriptRowDescriptor;
    switch (item.kind) {
      case "date-separator": {
        const measurementDecision = classifyTranscriptMeasurementPolicy({
          rowKind: "date-separator",
        });

        row = {
          rowId: item.rowId,
          reactKey: item.rowId,
          kind: "date-separator",
          date: item.payload,
          renderRevision: item.renderRevision,
          heightRevision: item.heightRevision,
          layoutRevision: TRANSCRIPT_ZERO_LAYOUT_REVISION,
          estimatedHeight: item.estimatedHeight,
          spacingBefore: 0,
          anchorPriority: "none",
          measurementPolicy: measurementDecision.policy,
          layoutPendingPolicy: measurementDecision.layoutPendingPolicy,
          capabilities: measurementDecision.capabilities,
          measurementSafetyReasons: measurementDecision.reasons,
          keepAlivePriority: measurementDecision.keepAlivePriority,
        };
        break;
      }
      case "message":
        row = {
          rowId: item.rowId,
          reactKey: item.rowId,
          kind: "message",
          messageId: item.messageId,
          responseStartMessageId: item.responseStartMessageId,
          blockIds: item.blockIds,
          messageContent:
            item.visibleContent === item.message.content
              ? undefined
              : item.visibleContent,
          messageContentContext:
            item.visibleContent === item.message.content
              ? undefined
              : item.message.content,
          renderRevision: item.renderRevision,
          heightRevision: item.heightRevision,
          layoutRevision: TRANSCRIPT_ZERO_LAYOUT_REVISION,
          estimatedHeight: item.estimatedHeight,
          spacingBefore: 0,
          anchorPriority: item.anchorPriority,
          measurementPolicy: item.measurementPolicy,
          layoutPendingPolicy: item.layoutPendingPolicy,
          capabilities: item.capabilities,
          measurementSafetyReasons: item.measurementSafetyReasons,
          keepAlivePriority: item.keepAlivePriority,
        };
        break;
      case "assistant-content-fragment":
        row = {
          rowId: item.rowId,
          reactKey: item.rowId,
          kind: "assistant-content-fragment",
          messageId: item.messageId,
          blockIds: item.blockIds,
          fragment: item.fragment,
          renderRevision: item.renderRevision,
          heightRevision: item.heightRevision,
          layoutRevision: TRANSCRIPT_ZERO_LAYOUT_REVISION,
          estimatedHeight: item.estimatedHeight,
          spacingBefore: 0,
          anchorPriority: item.anchorPriority,
          measurementPolicy: item.measurementPolicy,
          layoutPendingPolicy: item.layoutPendingPolicy,
          capabilities: item.capabilities,
          measurementSafetyReasons: item.measurementSafetyReasons,
          keepAlivePriority: item.keepAlivePriority,
        };
        break;
      case "agent-work":
        row = {
          rowId: item.rowId,
          reactKey: item.rowId,
          kind: "agent-work",
          messageId: item.messageId,
          agentWork: {
            workId: item.workId,
            message: item.message,
            content: item.content,
            isActiveWork: item.isActiveWork,
            hasFinalAnswer: item.hasFinalAnswer,
            thoughtCount: item.thoughtCount,
            toolCount: item.toolCount,
            textCount: item.textCount,
          },
          renderRevision: item.renderRevision,
          heightRevision: item.heightRevision,
          layoutRevision: TRANSCRIPT_ZERO_LAYOUT_REVISION,
          estimatedHeight: item.estimatedHeight,
          spacingBefore: 0,
          anchorPriority: item.anchorPriority,
          measurementPolicy: item.measurementPolicy,
          layoutPendingPolicy: item.layoutPendingPolicy,
          capabilities: item.capabilities,
          measurementSafetyReasons: item.measurementSafetyReasons,
          keepAlivePriority: item.keepAlivePriority,
        };
        break;
      default:
        return assertNever(item);
    }

    rowDescriptorByItem.set(item, {
      generation: rowDescriptorCacheGeneration,
      row,
    });
    return row;
  });

  return applyTranscriptRowLayout(rows);
}

export function canReuseTranscriptRowDescriptor(
  previous: TranscriptRowDescriptor,
  next: TranscriptRowDescriptor,
): boolean {
  if (previous === next) {
    return true;
  }

  if (
    previous.rowId === next.rowId &&
    previous.reactKey === next.reactKey &&
    previous.kind === next.kind &&
    previous.messageId === next.messageId &&
    previous.responseStartMessageId === next.responseStartMessageId &&
    previous.renderRevision === next.renderRevision &&
    previous.heightRevision === next.heightRevision &&
    previous.layoutRevision === next.layoutRevision &&
    previous.estimatedHeight === next.estimatedHeight &&
    previous.spacingBefore === next.spacingBefore &&
    previous.anchorPriority === next.anchorPriority &&
    previous.measurementPolicy === next.measurementPolicy &&
    previous.layoutPendingPolicy === next.layoutPendingPolicy &&
    previous.keepAlivePriority === next.keepAlivePriority &&
    previous.blockIds === next.blockIds &&
    previous.messageContent === next.messageContent &&
    previous.messageContentContext === next.messageContentContext &&
    previous.fragment === next.fragment &&
    previous.date === next.date &&
    previous.agentWork === next.agentWork &&
    previous.capabilities === next.capabilities &&
    previous.measurementSafetyReasons === next.measurementSafetyReasons
  ) {
    return true;
  }

  return (
    previous.rowId === next.rowId &&
    previous.reactKey === next.reactKey &&
    previous.kind === next.kind &&
    previous.messageId === next.messageId &&
    previous.responseStartMessageId === next.responseStartMessageId &&
    stringArraysEqual(previous.blockIds, next.blockIds) &&
    messageContentArraysEqual(previous.messageContent, next.messageContent) &&
    messageContentArraysEqual(
      previous.messageContentContext,
      next.messageContentContext,
    ) &&
    fragmentsEqual(previous.fragment, next.fragment) &&
    datePayloadsEqual(previous.date, next.date) &&
    agentWorkPayloadsEqual(previous.agentWork, next.agentWork) &&
    previous.renderRevision === next.renderRevision &&
    previous.heightRevision === next.heightRevision &&
    previous.layoutRevision === next.layoutRevision &&
    previous.estimatedHeight === next.estimatedHeight &&
    previous.spacingBefore === next.spacingBefore &&
    previous.anchorPriority === next.anchorPriority &&
    previous.measurementPolicy === next.measurementPolicy &&
    previous.layoutPendingPolicy === next.layoutPendingPolicy &&
    capabilitiesEqual(previous.capabilities, next.capabilities) &&
    stringArraysEqual(
      previous.measurementSafetyReasons,
      next.measurementSafetyReasons,
    ) &&
    previous.keepAlivePriority === next.keepAlivePriority
  );
}

function applyTranscriptRowLayout(
  rows: TranscriptRowDescriptor[],
): readonly TranscriptRowDescriptor[] {
  let previousRowKind: TranscriptRowDescriptor["kind"] | undefined;

  return rows.map((row, index) => {
    const spacingBefore = getTranscriptRowSpacingBefore({
      row,
      index,
      previousRowKind,
    });
    const layoutRevision = `layout-spacing:${spacingBefore}`;
    previousRowKind = row.kind;

    if (
      row.spacingBefore === spacingBefore &&
      row.layoutRevision === layoutRevision
    ) {
      return row;
    }

    return {
      ...row,
      spacingBefore,
      layoutRevision,
    };
  });
}

function getTranscriptRowSpacingBefore({
  row,
  index,
  previousRowKind,
}: {
  row: TranscriptRowDescriptor;
  index: number;
  previousRowKind?: TranscriptRowDescriptor["kind"];
}): number {
  if (
    index === 0 ||
    previousRowKind === "date-separator" ||
    isFragmentContinuation(row)
  ) {
    return 0;
  }

  if (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.startsWithHeading
  ) {
    return TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX;
  }

  return TRANSCRIPT_ROW_TOP_SPACING_PX;
}

function isFragmentContinuation(row: TranscriptRowDescriptor): boolean {
  return (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.isCodeContinuationChunk === true
  );
}

function agentWorkPayloadsEqual(
  left: TranscriptAgentWorkPayload | undefined,
  right: TranscriptAgentWorkPayload | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.workId === right.workId &&
    left.content.length === right.content.length &&
    left.content.every((content, index) =>
      fragmentContentEqual(content, right.content[index]),
    ) &&
    left.isActiveWork === right.isActiveWork &&
    left.hasFinalAnswer === right.hasFinalAnswer &&
    left.thoughtCount === right.thoughtCount &&
    left.toolCount === right.toolCount &&
    left.textCount === right.textCount
  );
}

function fragmentsEqual(
  left: TranscriptRowDescriptor["fragment"],
  right: TranscriptRowDescriptor["fragment"],
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.fragmentId === right.fragmentId &&
    left.fragmentIndex === right.fragmentIndex &&
    left.fragmentCount === right.fragmentCount &&
    left.role === right.role &&
    left.isStreamingTail === right.isStreamingTail &&
    left.messageScrollTarget === right.messageScrollTarget &&
    left.content.length === right.content.length &&
    left.content.every((content, index) =>
      fragmentContentEqual(content, right.content[index]),
    )
  );
}

function fragmentContentEqual(
  left: MessageContent,
  right: MessageContent | undefined,
): boolean {
  if (!right || left.type !== right.type) {
    return false;
  }
  if (left.type === "text" && right.type === "text") {
    return left.text === right.text;
  }
  return left === right;
}

function messageContentArraysEqual(
  left: readonly MessageContent[] | undefined,
  right: readonly MessageContent[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((content, index) =>
    fragmentContentEqual(content, right[index]),
  );
}

function stringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function datePayloadsEqual(
  left: TranscriptRowDescriptor["date"],
  right: TranscriptRowDescriptor["date"],
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.dateBucket === right.dateBucket &&
    left.timestamp === right.timestamp &&
    left.labelKey === right.labelKey &&
    left.label === right.label &&
    left.firstMessageId === right.firstMessageId
  );
}

function capabilitiesEqual(
  left: TranscriptRowCapabilities,
  right: TranscriptRowCapabilities,
): boolean {
  const leftKeys = Object.keys(left) as Array<keyof TranscriptRowCapabilities>;
  const rightKeys = Object.keys(right) as Array<
    keyof TranscriptRowCapabilities
  >;

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript item: ${JSON.stringify(value)}`);
}
