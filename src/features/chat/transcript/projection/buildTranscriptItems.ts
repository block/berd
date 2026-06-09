import type {
  Message,
  MessageContent,
  MessageMetadata,
  TextContent,
} from "@/shared/types/messages";
import {
  classifyTranscriptMeasurementPolicy,
  type TranscriptMeasurementPolicyDecision,
} from "../measurement";
import {
  buildBlockId,
  buildMessageRevisions,
  type RevisionParts,
} from "./messageRevisions";
import type {
  TranscriptAnchorPriority,
  TranscriptAssistantContentFragmentItem,
  TranscriptAssistantContentFragmentRole,
  TranscriptDateLabelKey,
  TranscriptItemDescriptor,
  TranscriptMessageItem,
} from "./transcriptItemTypes";

interface BuildTranscriptItemsInput {
  messages: readonly Message[];
  streamingMessageId: string | null;
  nowBucket: string;
  localeKey: string;
  calendarRevisionToken: string;
}

const ASSISTANT_FRAGMENT_MIN_LINE_COUNT = 60;
const ASSISTANT_FRAGMENT_TARGET_LINE_COUNT = 40;
const ASSISTANT_FRAGMENT_BLANK_LINE_SEARCH_RADIUS = 8;
const ASSISTANT_FRAGMENT_CHROME_ESTIMATE = 32;
const SINGLE_TEXT_BLOCK_IDS = ["text:0"] as const;
const STATIC_TEXT_MEASUREMENT_DECISION = {
  policy: "measure-shell",
  layoutPendingPolicy: "can-finalize",
  keepAlivePriority: "none",
  capabilities: {
    stateful: false,
    hasMcpApp: false,
    hasHostCalls: false,
    hasHostActionHandlers: false,
    hasActiveTimer: false,
    hasActiveToolWork: false,
    hasActiveMcpHostRequest: false,
    hasActiveNestedToolRequest: false,
    hasDynamicAsyncLayout: false,
    hasPendingLayout: false,
    hasFocusedDescendant: false,
    hasOpenOverlay: false,
    hasOpenMenu: false,
    hasOpenDialog: false,
    hasOpenPopover: false,
    hasOpenLightbox: false,
    hasCopyFeedback: false,
    hasImageContent: false,
    hasToolContent: false,
    hasReasoningContent: false,
    hasActionRequired: false,
    hasStreamingContent: false,
    hasUnknownUnsafeDescendants: false,
    protectsSelection: false,
    canOffscreenRenderReal: false,
    canOffscreenRenderShell: true,
  },
  reasons: ["text-row-requires-audit"],
} as const satisfies TranscriptMeasurementPolicyDecision;

interface DateBucketRange {
  dateBucket: string;
  startMs: number;
  endMs: number;
}

interface MarkdownUnsafeSplitRange {
  startIndex: number;
  endIndex: number;
}

interface CachedStaticTextMessageItem {
  generation: number;
  content: TextContent;
  metadata: MessageMetadata | undefined;
  text: string;
  item: TranscriptMessageItem;
}

interface CachedProjectedMessageItem {
  generation: number;
  visibleContent: readonly MessageContent[];
  metadata: MessageMetadata | undefined;
  item: TranscriptMessageItem;
}

const staticTextMessageItemCache = new WeakMap<
  Message,
  CachedStaticTextMessageItem
>();
const projectedMessageItemCache = new WeakMap<
  Message,
  CachedProjectedMessageItem
>();
let staticTextMessageItemCacheGeneration = 0;

export function invalidateTranscriptItemDescriptorCache(): void {
  staticTextMessageItemCacheGeneration += 1;
}

export function buildTranscriptItems({
  messages,
  streamingMessageId,
  nowBucket,
  localeKey,
  calendarRevisionToken,
}: BuildTranscriptItemsInput): readonly TranscriptItemDescriptor[] {
  const items: TranscriptItemDescriptor[] = [];
  let previousDateBucket: string | null = null;
  let cachedDateBucketRange: DateBucketRange | null = null;

  for (const message of messages) {
    if (!isVisibleTranscriptMessage(message)) {
      continue;
    }

    const dateBucketRange = getDateBucketRange(
      message.created,
      cachedDateBucketRange,
    );
    cachedDateBucketRange = dateBucketRange;
    const dateBucket = dateBucketRange.dateBucket;
    if (dateBucket !== previousDateBucket) {
      const datePayload = {
        dateBucket,
        timestamp: message.created,
        labelKey: getDateLabelKey(dateBucket, nowBucket),
        label: getDateLabel(dateBucket, nowBucket),
        firstMessageId: message.id,
      };
      const dateRevision = [
        "date",
        datePayload.dateBucket,
        datePayload.labelKey,
        localeKey,
        nowBucket,
        calendarRevisionToken,
      ].join(":");

      items.push({
        itemId: `date:${dateBucket}:before:${message.id}`,
        kind: "date-separator",
        rowId: `date:${dateBucket}:before:${message.id}`,
        payload: datePayload,
        renderRevision: dateRevision,
        heightRevision: `date-height:${dateBucket}:${datePayload.labelKey}:${localeKey}`,
        estimatedHeight: 36,
      });
      previousDateBucket = dateBucket;
    }

    const isStreaming = message.id === streamingMessageId;
    const visibleContent = getUserVisibleMessageContent(message.content);
    const fragmentItems = buildAssistantTextFragmentItems({
      message,
      visibleContent,
      isStreaming,
    });

    if (fragmentItems) {
      items.push(...fragmentItems);
      continue;
    }

    const cachedProjectedItem = getCachedProjectedMessageItem({
      message,
      visibleContent,
      isStreaming,
    });
    if (cachedProjectedItem) {
      items.push(cachedProjectedItem);
      continue;
    }

    const cachedStaticTextItem = getCachedStaticTextMessageItem({
      message,
      visibleContent,
      isStreaming,
    });
    if (cachedStaticTextItem) {
      items.push(cachedStaticTextItem);
      continue;
    }

    const blockIds = getBlockIds(visibleContent);
    const measurementDecision = getMessageMeasurementDecision({
      message,
      visibleContent,
      isStreaming,
    });
    const revisions = buildMessageRevisions(message, visibleContent);

    items.push(
      createMessageItem({
        message,
        visibleContent,
        blockIds,
        searchableText: getSearchableText(message, visibleContent),
        isStreaming,
        revisions,
        estimatedHeight: estimateMessageHeight(message, visibleContent),
        measurementDecision,
      }),
    );
  }

  return items;
}

function getCachedProjectedMessageItem({
  message,
  visibleContent,
  isStreaming,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  isStreaming: boolean;
}): TranscriptMessageItem | null {
  if (
    isStreaming ||
    (visibleContent.length === 1 && visibleContent[0]?.type === "text")
  ) {
    return null;
  }

  const cached = projectedMessageItemCache.get(message);
  if (
    cached?.generation === staticTextMessageItemCacheGeneration &&
    cached.visibleContent === visibleContent &&
    cached.metadata === message.metadata
  ) {
    return cached.item;
  }

  const item = createMessageItem({
    message,
    visibleContent,
    blockIds: getBlockIds(visibleContent),
    searchableText: getSearchableText(message, visibleContent),
    isStreaming,
    revisions: buildMessageRevisions(message, visibleContent),
    estimatedHeight: estimateMessageHeight(message, visibleContent),
    measurementDecision: getMessageMeasurementDecision({
      message,
      visibleContent,
      isStreaming,
    }),
  });
  projectedMessageItemCache.set(message, {
    generation: staticTextMessageItemCacheGeneration,
    visibleContent,
    metadata: message.metadata,
    item,
  });
  return item;
}

function getCachedStaticTextMessageItem({
  message,
  visibleContent,
  isStreaming,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  isStreaming: boolean;
}): TranscriptMessageItem | null {
  if (
    isStreaming ||
    visibleContent.length !== 1 ||
    visibleContent[0]?.type !== "text"
  ) {
    return null;
  }

  const content = visibleContent[0];
  const cached = staticTextMessageItemCache.get(message);
  if (
    cached?.generation === staticTextMessageItemCacheGeneration &&
    cached?.content === content &&
    cached.metadata === message.metadata &&
    cached.text === content.text
  ) {
    return cached.item;
  }

  const item = createMessageItem({
    message,
    visibleContent,
    blockIds: SINGLE_TEXT_BLOCK_IDS,
    searchableText: content.text,
    isStreaming,
    revisions: buildMessageRevisions(message, visibleContent),
    estimatedHeight: estimateMessageHeight(message, visibleContent),
    measurementDecision: getMessageMeasurementDecision({
      message,
      visibleContent,
      isStreaming,
    }),
  });
  staticTextMessageItemCache.set(message, {
    generation: staticTextMessageItemCacheGeneration,
    content,
    metadata: message.metadata,
    text: content.text,
    item,
  });
  return item;
}

function createMessageItem({
  message,
  visibleContent,
  blockIds,
  searchableText,
  isStreaming,
  revisions,
  estimatedHeight,
  measurementDecision,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  blockIds: readonly string[];
  searchableText: string;
  isStreaming: boolean;
  revisions: RevisionParts;
  estimatedHeight: number;
  measurementDecision: TranscriptMeasurementPolicyDecision;
}): TranscriptMessageItem {
  return {
    itemId: `message:${message.id}`,
    kind: "message",
    rowId: `message:${message.id}`,
    messageId: message.id,
    message,
    visibleContent,
    blockIds,
    searchableText,
    isStreaming,
    renderRevision: revisions.renderRevision,
    heightRevision: revisions.heightRevision,
    estimatedHeight,
    capabilities: measurementDecision.capabilities,
    measurementPolicy: measurementDecision.policy,
    layoutPendingPolicy: measurementDecision.layoutPendingPolicy,
    measurementSafetyReasons: measurementDecision.reasons,
    anchorPriority: isStreaming ? "streaming" : "stable",
    keepAlivePriority: measurementDecision.keepAlivePriority,
  };
}

function getMessageMeasurementDecision({
  message,
  visibleContent,
  isStreaming,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  isStreaming: boolean;
}): TranscriptMeasurementPolicyDecision {
  if (
    !isStreaming &&
    visibleContent.length === 1 &&
    visibleContent[0]?.type === "text" &&
    !message.metadata?.completionStatus &&
    !message.metadata?.attachments?.length
  ) {
    return STATIC_TEXT_MEASUREMENT_DECISION;
  }

  return classifyTranscriptMeasurementPolicy({
    rowKind: "message",
    message,
    content: visibleContent,
    capabilities: isStreaming
      ? { hasDynamicAsyncLayout: true, hasStreamingContent: true }
      : undefined,
  });
}

function getDateBucketRange(
  timestamp: number,
  previousRange: DateBucketRange | null,
): DateBucketRange {
  if (
    previousRange &&
    timestamp >= previousRange.startMs &&
    timestamp < previousRange.endMs
  ) {
    return previousRange;
  }

  const date = new Date(timestamp);
  const startMs = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const endMs = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime();

  return {
    dateBucket: formatDateBucket(date),
    startMs,
    endMs,
  };
}

function formatDateBucket(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function getBlockIds(
  visibleContent: readonly MessageContent[],
): readonly string[] {
  if (visibleContent.length === 1 && visibleContent[0]?.type === "text") {
    return SINGLE_TEXT_BLOCK_IDS;
  }

  return visibleContent.map(buildBlockId);
}

interface BuildAssistantTextFragmentItemsInput {
  message: Message;
  visibleContent: readonly MessageContent[];
  isStreaming: boolean;
}

function buildAssistantTextFragmentItems({
  message,
  visibleContent,
  isStreaming,
}: BuildAssistantTextFragmentItemsInput):
  | readonly TranscriptAssistantContentFragmentItem[]
  | null {
  if (isStreaming) {
    return null;
  }

  if (!canProjectAssistantTextFragments(message, visibleContent)) {
    return null;
  }

  const sourceText = visibleContent[0]?.text ?? "";
  const textChunks = splitAssistantTextIntoChunks(sourceText);
  if (!textChunks) {
    return null;
  }

  const searchableText = getSearchableText(message, visibleContent);
  const lastIndex = textChunks.length - 1;
  const useStreamingFragmentIds = shouldUseStreamingFragmentIds({
    message,
    isStreaming,
  });

  return textChunks.map((text, fragmentIndex) => {
    const isStreamingTail = isStreaming && fragmentIndex === lastIndex;
    const fragmentId = useStreamingFragmentIds
      ? fragmentIndex === lastIndex
        ? "stream-tail"
        : `stream-block-${fragmentIndex}`
      : `block-${fragmentIndex}`;
    const fragmentContent: readonly MessageContent[] = [
      {
        ...visibleContent[0],
        text,
      },
    ];
    const fragmentMessage = createFragmentRevisionMessage({
      message,
      content: fragmentContent,
      fragmentId,
      isStreamingTail,
    });
    const revisions = buildMessageRevisions(fragmentMessage, fragmentContent);
    const anchorPriority: TranscriptAnchorPriority = isStreamingTail
      ? "streaming"
      : "stable";
    const measurementDecision = classifyTranscriptMeasurementPolicy({
      rowKind: "assistant-content-fragment",
      message: fragmentMessage,
      content: fragmentContent,
      capabilities: isStreamingTail
        ? { hasDynamicAsyncLayout: true, hasStreamingContent: true }
        : undefined,
      options: {
        allowCompletedFragmentRealMeasurement: !isStreamingTail,
      },
    });
    const rowId = `message:${message.id}:${fragmentId}`;

    return {
      itemId: rowId,
      kind: "assistant-content-fragment",
      rowId,
      messageId: message.id,
      message,
      visibleContent: fragmentContent,
      blockIds: [`text:${fragmentId}`],
      searchableText,
      fragment: {
        fragmentId,
        fragmentIndex,
        fragmentCount: textChunks.length,
        role: getAssistantFragmentRole(fragmentIndex, textChunks.length),
        content: fragmentContent,
        isStreamingTail,
        messageScrollTarget: isStreaming
          ? isStreamingTail
          : fragmentIndex === 0,
      },
      renderRevision: [
        "assistant-fragment",
        message.id,
        fragmentId,
        revisions.renderRevision,
      ].join(":"),
      heightRevision: [
        "assistant-fragment-height",
        message.id,
        fragmentId,
        revisions.heightRevision,
      ].join(":"),
      estimatedHeight:
        estimateFragmentHeight(text) +
        getAssistantFragmentChromeEstimate(fragmentIndex, textChunks.length),
      capabilities: measurementDecision.capabilities,
      measurementPolicy: measurementDecision.policy,
      layoutPendingPolicy: measurementDecision.layoutPendingPolicy,
      measurementSafetyReasons: measurementDecision.reasons,
      anchorPriority,
      keepAlivePriority: measurementDecision.keepAlivePriority,
    } satisfies TranscriptAssistantContentFragmentItem;
  });
}

function shouldUseStreamingFragmentIds({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming: boolean;
}): boolean {
  if (isStreaming) {
    return true;
  }

  const completionStatus = message.metadata?.completionStatus;
  return completionStatus === "inProgress" || completionStatus === "stopped";
}

function canProjectAssistantTextFragments(
  message: Message,
  visibleContent: readonly MessageContent[],
): visibleContent is readonly [TextContent] {
  if (message.role !== "assistant") {
    return false;
  }
  if (visibleContent.length !== 1 || visibleContent[0]?.type !== "text") {
    return false;
  }
  if (
    message.metadata?.attachments?.length ||
    message.metadata?.chips?.length
  ) {
    return false;
  }
  return true;
}

function splitAssistantTextIntoChunks(text: string): readonly string[] | null {
  if (text.includes("```") || text.includes("~~~")) {
    return null;
  }

  const lines = text.split(/\n/);
  if (lines.length < ASSISTANT_FRAGMENT_MIN_LINE_COUNT) {
    return null;
  }

  const unsafeSplitRanges = findMarkdownTableRanges(lines);
  const chunks: string[] = [];
  let startIndex = 0;
  while (startIndex < lines.length) {
    const remainingLineCount = lines.length - startIndex;
    if (remainingLineCount <= ASSISTANT_FRAGMENT_TARGET_LINE_COUNT) {
      chunks.push(lines.slice(startIndex).join("\n"));
      break;
    }

    const splitIndex = findAssistantFragmentSplitIndex(
      lines,
      startIndex,
      unsafeSplitRanges,
    );
    if (splitIndex == null || splitIndex <= startIndex) {
      return null;
    }

    chunks.push(lines.slice(startIndex, splitIndex).join("\n"));
    startIndex = splitIndex;
  }

  return chunks.length > 1 ? chunks : null;
}

function findAssistantFragmentSplitIndex(
  lines: readonly string[],
  startIndex: number,
  unsafeSplitRanges: readonly MarkdownUnsafeSplitRange[],
): number | null {
  const targetIndex = Math.min(
    lines.length,
    startIndex + ASSISTANT_FRAGMENT_TARGET_LINE_COUNT,
  );
  const minIndex = Math.max(
    startIndex + 1,
    targetIndex - ASSISTANT_FRAGMENT_BLANK_LINE_SEARCH_RADIUS,
  );
  const maxIndex = Math.min(
    lines.length - 1,
    targetIndex + ASSISTANT_FRAGMENT_BLANK_LINE_SEARCH_RADIUS,
  );

  for (let index = targetIndex; index <= maxIndex; index += 1) {
    if (lines[index]?.trim() === "") {
      const splitIndex = index + 1;
      if (isSafeMarkdownSplitIndex(splitIndex, unsafeSplitRanges)) {
        return splitIndex;
      }
    }
  }
  for (let index = targetIndex - 1; index >= minIndex; index -= 1) {
    if (lines[index]?.trim() === "") {
      const splitIndex = index + 1;
      if (isSafeMarkdownSplitIndex(splitIndex, unsafeSplitRanges)) {
        return splitIndex;
      }
    }
  }

  if (isSafeMarkdownSplitIndex(targetIndex, unsafeSplitRanges)) {
    return targetIndex;
  }

  return findNearestSafeMarkdownSplitIndex(
    targetIndex,
    startIndex,
    lines.length,
    unsafeSplitRanges,
  );
}

function findNearestSafeMarkdownSplitIndex(
  targetIndex: number,
  startIndex: number,
  lineCount: number,
  unsafeSplitRanges: readonly MarkdownUnsafeSplitRange[],
): number | null {
  const unsafeRange = findUnsafeMarkdownSplitRange(
    targetIndex,
    unsafeSplitRanges,
  );
  if (!unsafeRange) {
    return targetIndex;
  }

  const before =
    unsafeRange.startIndex > startIndex ? unsafeRange.startIndex : null;
  const after =
    unsafeRange.endIndex > startIndex
      ? Math.min(unsafeRange.endIndex, lineCount)
      : null;

  if (before == null) {
    return after;
  }
  if (after == null) {
    return before;
  }

  return targetIndex - before <= after - targetIndex ? before : after;
}

function isSafeMarkdownSplitIndex(
  splitIndex: number,
  unsafeSplitRanges: readonly MarkdownUnsafeSplitRange[],
): boolean {
  return !findUnsafeMarkdownSplitRange(splitIndex, unsafeSplitRanges);
}

function findUnsafeMarkdownSplitRange(
  splitIndex: number,
  unsafeSplitRanges: readonly MarkdownUnsafeSplitRange[],
): MarkdownUnsafeSplitRange | null {
  return (
    unsafeSplitRanges.find(
      (range) => range.startIndex < splitIndex && splitIndex < range.endIndex,
    ) ?? null
  );
}

function findMarkdownTableRanges(
  lines: readonly string[],
): readonly MarkdownUnsafeSplitRange[] {
  const ranges: MarkdownUnsafeSplitRange[] = [];
  let index = 0;
  while (index < lines.length - 1) {
    if (
      isPotentialMarkdownTableRow(lines[index] ?? "") &&
      isMarkdownTableDelimiterLine(lines[index + 1] ?? "")
    ) {
      const startIndex = index;
      let endIndex = index + 2;
      while (
        endIndex < lines.length &&
        isPotentialMarkdownTableRow(lines[endIndex] ?? "")
      ) {
        endIndex += 1;
      }
      ranges.push({ startIndex, endIndex });
      index = endIndex;
      continue;
    }

    index += 1;
  }

  return ranges;
}

function isPotentialMarkdownTableRow(line: string): boolean {
  return line.trim() !== "" && hasUnescapedPipe(line);
}

function isMarkdownTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!hasUnescapedPipe(trimmed)) {
    return false;
  }

  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function hasUnescapedPipe(line: string): boolean {
  let slashCount = 0;
  for (const character of line) {
    if (character === "\\") {
      slashCount += 1;
      continue;
    }

    if (character === "|" && slashCount % 2 === 0) {
      return true;
    }

    slashCount = 0;
  }

  return false;
}

function createFragmentRevisionMessage({
  message,
  content,
  fragmentId,
  isStreamingTail,
}: {
  message: Message;
  content: readonly MessageContent[];
  fragmentId: string;
  isStreamingTail: boolean;
}): Message {
  return {
    ...message,
    id: `${message.id}:${fragmentId}`,
    content: [...content],
    metadata: isStreamingTail
      ? message.metadata
      : withoutCompletionStatus(message.metadata),
  };
}

function withoutCompletionStatus(
  metadata: MessageMetadata | undefined,
): MessageMetadata | undefined {
  if (!metadata?.completionStatus) {
    return metadata;
  }

  const { completionStatus: _completionStatus, ...rest } = metadata;
  return rest;
}

function getAssistantFragmentRole(
  fragmentIndex: number,
  fragmentCount: number,
): TranscriptAssistantContentFragmentRole {
  if (fragmentCount === 1) {
    return "single";
  }
  if (fragmentIndex === 0) {
    return "start";
  }
  if (fragmentIndex === fragmentCount - 1) {
    return "end";
  }
  return "middle";
}

function getAssistantFragmentChromeEstimate(
  fragmentIndex: number,
  fragmentCount: number,
): number {
  if (fragmentCount === 1) {
    return ASSISTANT_FRAGMENT_CHROME_ESTIMATE * 2;
  }
  if (fragmentIndex === 0 || fragmentIndex === fragmentCount - 1) {
    return ASSISTANT_FRAGMENT_CHROME_ESTIMATE;
  }
  return 0;
}

export function getVisibleTranscriptMessages(
  messages: readonly Message[],
): readonly Message[] {
  return messages.filter(isVisibleTranscriptMessage);
}

function isVisibleTranscriptMessage(message: Message): boolean {
  if (message.metadata?.userVisible === false) {
    return false;
  }

  return !(
    message.role === "assistant" &&
    message.content.length === 0 &&
    message.metadata?.completionStatus === "inProgress"
  );
}

export function getUserVisibleMessageContent(
  content: readonly MessageContent[],
): readonly MessageContent[] {
  let filtered: MessageContent[] | null = null;

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!block) {
      continue;
    }
    const audience =
      "annotations" in block ? block.annotations?.audience : undefined;
    const visible =
      !audience || audience.length === 0 || audience.includes("user");
    if (visible) {
      filtered?.push(block);
      continue;
    }

    filtered ??= content.slice(0, index);
  }

  return filtered ?? content;
}

export function toDateBucket(timestamp: number): string {
  return formatDateBucket(new Date(timestamp));
}

function getSearchableText(
  _message: Message,
  visibleContent: readonly MessageContent[],
): string {
  if (visibleContent.length === 1 && visibleContent[0]?.type === "text") {
    return visibleContent[0].text;
  }

  return visibleContent
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function getDateLabelKey(
  dateBucket: string,
  nowBucket: string,
): TranscriptDateLabelKey {
  if (dateBucket === nowBucket) {
    return "today";
  }
  if (dateBucket === previousBucket(nowBucket)) {
    return "yesterday";
  }
  return "date";
}

function getDateLabel(dateBucket: string, nowBucket: string): string {
  const labelKey = getDateLabelKey(dateBucket, nowBucket);
  if (labelKey === "today") {
    return "today";
  }
  if (labelKey === "yesterday") {
    return "yesterday";
  }
  return dateBucket;
}

function previousBucket(bucket: string): string | null {
  const parsed = new Date(`${bucket}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setDate(parsed.getDate() - 1);
  return toDateBucket(parsed.getTime());
}

function estimateMessageHeight(
  message: Message,
  visibleContent: readonly MessageContent[],
): number {
  const baseHeight = message.role === "user" ? 76 : 96;
  const contentHeight = visibleContent.reduce((total, content) => {
    switch (content.type) {
      case "text":
      case "thinking":
      case "reasoning":
        return total + estimateTextHeight(content.text);
      case "image":
        return total + 220;
      case "toolRequest":
        return total + 92;
      case "toolResponse":
        return total + 72 + estimateTextHeight(content.result);
      case "mcpApp":
        return total + 260;
      case "actionRequired":
        return total + 104;
      case "redactedThinking":
        return total + 48;
      case "systemNotification":
        return total + 40 + estimateTextHeight(content.text);
      default:
        return assertNever(content);
    }
  }, 0);

  const attachmentHeight =
    message.metadata?.attachments && message.metadata.attachments.length > 0
      ? 32
      : 0;
  const chipHeight =
    message.metadata?.chips && message.metadata.chips.length > 0 ? 28 : 0;

  return Math.max(
    baseHeight,
    baseHeight + contentHeight + attachmentHeight + chipHeight,
  );
}

function estimateTextHeight(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      lines += 1;
    } else if (code === 13) {
      lines += 1;
      if (text.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    }
  }
  const softWrapLines = Math.ceil(text.length / 96);
  return Math.max(lines, softWrapLines) * 22;
}

function estimateFragmentHeight(text: string): number {
  return Math.max(36, estimateTextHeight(text));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message content type: ${JSON.stringify(value)}`);
}
