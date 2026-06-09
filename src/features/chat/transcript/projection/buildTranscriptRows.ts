import { classifyTranscriptMeasurementPolicy } from "../measurement";
import type { MessageContent } from "@/shared/types/messages";
import type {
  TranscriptItemDescriptor,
  TranscriptRowCapabilities,
  TranscriptRowDescriptor,
} from "./transcriptItemTypes";

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
  return items.map((item) => {
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
          estimatedHeight: item.estimatedHeight,
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
          blockIds: item.blockIds,
          renderRevision: item.renderRevision,
          heightRevision: item.heightRevision,
          estimatedHeight: item.estimatedHeight,
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
          estimatedHeight: item.estimatedHeight,
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
    previous.renderRevision === next.renderRevision &&
    previous.heightRevision === next.heightRevision &&
    previous.estimatedHeight === next.estimatedHeight &&
    previous.anchorPriority === next.anchorPriority &&
    previous.measurementPolicy === next.measurementPolicy &&
    previous.layoutPendingPolicy === next.layoutPendingPolicy &&
    previous.keepAlivePriority === next.keepAlivePriority &&
    previous.blockIds === next.blockIds &&
    previous.fragment === next.fragment &&
    previous.date === next.date &&
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
    stringArraysEqual(previous.blockIds, next.blockIds) &&
    fragmentsEqual(previous.fragment, next.fragment) &&
    datePayloadsEqual(previous.date, next.date) &&
    previous.renderRevision === next.renderRevision &&
    previous.heightRevision === next.heightRevision &&
    previous.estimatedHeight === next.estimatedHeight &&
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
