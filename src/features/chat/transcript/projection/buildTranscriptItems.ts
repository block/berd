import {
  getTextContent,
  type Message,
  type MessageContent,
  type MessageMetadata,
  type ReasoningContent,
  type TextContent,
  type ThinkingContent,
} from "@/shared/types/messages";
import {
  isVoiceConversationEmptyResponse,
  stripVoiceConversationEmptyResponseSuffix,
} from "@/features/chat/lib/voiceConversationNoop";
import {
  classifyTranscriptMeasurementPolicy,
  type TranscriptMeasurementPolicyDecision,
} from "../measurement";
import {
  buildBlockId,
  buildMessageRevisions,
  stableValueRevision,
  type RevisionParts,
} from "./messageRevisions";
import type {
  TranscriptAgentWorkItem,
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
const ASSISTANT_FRAGMENT_CODE_MIN_LINE_COUNT = 20;
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
  // Reasoning signatures displayed during the current agent/tool sequence. Tool
  // responses are stored as user messages, but product-wise they are still part
  // of the assistant's work turn, so they should not reset this set.
  let displayedReasoningSignatures = new Set<string>();

  for (const message of getVisibleTranscriptMessages(messages)) {
    const visibleContent = expandReasoningContentSections(
      getUserVisibleMessageContent(message.content),
    );
    if (message.role === "user" && visibleContent.length === 0) {
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
    const contentForProjection: readonly MessageContent[] =
      message.role === "assistant"
        ? filterDuplicateDisplayedReasoning(
            visibleContent,
            displayedReasoningSignatures,
          )
        : visibleContent;

    if (message.role === "assistant") {
      for (const signature of getLeadingReasoningSignatures(
        contentForProjection,
      )) {
        displayedReasoningSignatures.add(signature);
      }
    } else if (!isToolResponseOnlyContent(contentForProjection)) {
      displayedReasoningSignatures = new Set<string>();
    }

    // A message that was nothing but duplicate reasoning collapses to empty and
    // is dropped entirely.
    if (message.role === "assistant" && contentForProjection.length === 0) {
      continue;
    }

    const agentWorkItems = buildAgentWorkItems({
      message,
      visibleContent: contentForProjection,
      isStreaming,
    });
    if (agentWorkItems) {
      items.push(...agentWorkItems);
      continue;
    }

    const fragmentItems = buildAssistantTextFragmentItems({
      message,
      visibleContent: contentForProjection,
      isStreaming,
    });

    if (fragmentItems) {
      items.push(...fragmentItems);
      continue;
    }

    const cachedProjectedItem = getCachedProjectedMessageItem({
      message,
      visibleContent: contentForProjection,
      isStreaming,
    });
    if (cachedProjectedItem) {
      items.push(cachedProjectedItem);
      continue;
    }

    const cachedStaticTextItem = getCachedStaticTextMessageItem({
      message,
      visibleContent: contentForProjection,
      isStreaming,
    });
    if (cachedStaticTextItem) {
      items.push(cachedStaticTextItem);
      continue;
    }

    const blockIds = getBlockIds(contentForProjection);
    const measurementDecision = getMessageMeasurementDecision({
      message,
      visibleContent: contentForProjection,
      isStreaming,
    });
    const revisions = buildMessageRevisions(message, contentForProjection);

    items.push(
      createMessageItem({
        message,
        visibleContent: contentForProjection,
        blockIds,
        searchableText: getSearchableText(message, contentForProjection),
        isStreaming,
        revisions,
        estimatedHeight: estimateMessageHeight(message, contentForProjection),
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
  responseStartMessageId,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  blockIds: readonly string[];
  searchableText: string;
  isStreaming: boolean;
  revisions: RevisionParts;
  estimatedHeight: number;
  measurementDecision: TranscriptMeasurementPolicyDecision;
  responseStartMessageId?: string;
}): TranscriptMessageItem {
  return {
    itemId: `message:${message.id}`,
    kind: "message",
    rowId: `message:${message.id}`,
    messageId: message.id,
    responseStartMessageId,
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

  return textChunks.map((chunk, fragmentIndex) => {
    const { text, isCodeContinuationChunk, startsWithHeading } = chunk;
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
        isCodeContinuationChunk,
        startsWithHeading,
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

type ToolContent = Extract<
  MessageContent,
  { type: "toolRequest" | "toolResponse" }
>;
type ReasoningLikeContent = Extract<
  MessageContent,
  { type: "thinking" | "reasoning" | "redactedThinking" }
>;
type TextLikeContent = Extract<MessageContent, { type: "text" }>;

function isToolContent(block: MessageContent): block is ToolContent {
  return block.type === "toolRequest" || block.type === "toolResponse";
}

function isReasoningContent(
  block: MessageContent,
): block is ReasoningLikeContent {
  return (
    block.type === "thinking" ||
    block.type === "reasoning" ||
    block.type === "redactedThinking"
  );
}

function isTextContent(block: MessageContent): block is TextLikeContent {
  return block.type === "text";
}

function normalizeReasoningText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

const REASONING_DUPLICATE_MIN_LENGTH = 80;

interface ReasoningHeaderMatch {
  title: string;
  headerText: string;
  body: string;
}

function getLeadingReasoningHeader(text: string): ReasoningHeaderMatch | null {
  const trimmedStartLength = text.length - text.trimStart().length;
  const withoutLeadingWhitespace = text.slice(trimmedStartLength);
  const headerMatch = withoutLeadingWhitespace.match(
    /^(?:\*\*([^\n*]{1,120})\*\*|#{1,6}\s+([^\n]{1,120}))\s*\n{1,}/,
  );
  if (!headerMatch) {
    return null;
  }

  const title = (headerMatch[1] ?? headerMatch[2] ?? "").trim();
  if (!title) {
    return null;
  }

  const headerText = text.slice(0, trimmedStartLength + headerMatch[0].length);
  return {
    title,
    headerText,
    body: text.slice(trimmedStartLength + headerMatch[0].length),
  };
}

function canonicalizeReasoningBody(text: string): string {
  const header = getLeadingReasoningHeader(text);
  return normalizeReasoningText(header ? header.body : text);
}

function canonicalizeReasoningCandidate(
  text: string,
  title: string | null,
): string {
  let signature = canonicalizeReasoningBody(text);
  const titleSignature = title ? normalizeReasoningText(title) : null;
  if (!titleSignature) {
    return signature;
  }

  if (signature.startsWith(titleSignature)) {
    signature = signature.slice(titleSignature.length).trim();
  }
  if (signature.endsWith(titleSignature)) {
    signature = signature.slice(0, -titleSignature.length).trim();
  }
  return signature;
}

function areDuplicateReasoningBodies(
  left: string,
  right: string,
  title: string | null,
): boolean {
  const leftSignature = canonicalizeReasoningCandidate(left, title);
  const rightSignature = canonicalizeReasoningCandidate(right, title);
  return (
    leftSignature.length >= REASONING_DUPLICATE_MIN_LENGTH &&
    leftSignature === rightSignature
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripReasoningBoundaryTitleArtifacts(
  body: string,
  title: string | null,
): string {
  if (!title) {
    return body;
  }

  const escapedTitle = escapeRegExp(title);
  return body
    .replace(new RegExp(`^\\s*(?:\\*\\*)?${escapedTitle}(?:\\*\\*)?\\s*`), "")
    .replace(new RegExp(`\\s*(?:\\*\\*)?${escapedTitle}(?:\\*\\*)?\\s*$`), "");
}

function collapseDuplicatedReasoningBody(
  body: string,
  title: string | null,
): string {
  const strippedBody = stripReasoningBoundaryTitleArtifacts(body, title);
  const trimmedBody = strippedBody.trim();
  if (trimmedBody.length < REASONING_DUPLICATE_MIN_LENGTH * 2) {
    return strippedBody;
  }

  const splitCandidates = new Set<number>();
  const blankLinePattern = /\n\s*\n/g;
  for (const match of trimmedBody.matchAll(blankLinePattern)) {
    splitCandidates.add(match.index + match[0].length);
  }

  if (title) {
    const escapedTitle = escapeRegExp(title);
    const titlePattern = new RegExp(
      `(?:\\*\\*)?${escapedTitle}(?:\\*\\*)?`,
      "g",
    );
    for (const match of trimmedBody.matchAll(titlePattern)) {
      splitCandidates.add(match.index);
      splitCandidates.add(match.index + match[0].length);
    }
  }

  for (const splitIndex of Array.from(splitCandidates).sort((a, b) => a - b)) {
    const left = trimmedBody.slice(0, splitIndex).trim();
    const right = trimmedBody.slice(splitIndex).trim();
    if (!left || !right) continue;
    if (areDuplicateReasoningBodies(left, right, title)) {
      return left;
    }
  }

  return strippedBody;
}

function sanitizeReasoningTextForDisplay(text: string): string {
  const header = getLeadingReasoningHeader(text);
  if (!header) {
    return collapseDuplicatedReasoningBody(text, null);
  }

  const collapsedBody = collapseDuplicatedReasoningBody(
    header.body,
    header.title,
  );
  return `${header.headerText}${collapsedBody.trimStart()}`;
}

function getCanonicalReasoningSignature(text: string): string | null {
  const sanitizedText = sanitizeReasoningTextForDisplay(text);
  const header = getLeadingReasoningHeader(sanitizedText);
  const canonicalText = canonicalizeReasoningCandidate(
    sanitizedText,
    header?.title ?? null,
  );
  return canonicalText || null;
}

function getReasoningSignature(block: MessageContent): string | null {
  if (!isReasoningContent(block)) return null;
  if (block.type === "redactedThinking") return "[redacted]";
  return getCanonicalReasoningSignature(block.text);
}

// Signatures of the leading run of reasoning blocks at the start of a message.
// Used to detect when a provider re-emits thoughts it already sent as standalone
// thinking, even when one backend block contains several titled sections.
function getLeadingReasoningSignatures(
  content: readonly MessageContent[],
): readonly string[] {
  const signatures: string[] = [];
  for (const block of content) {
    const signature = getReasoningSignature(block);
    if (!signature) break;
    signatures.push(signature);
  }
  return signatures;
}

// Strip leading reasoning blocks from a message when they exactly repeat the
// reasoning we already displayed on the previous assistant message. Returns []
// when the whole message was nothing but that duplicate reasoning (caller drops
// it). Anything that isn't a leading exact-duplicate is left untouched.
function isToolResponseOnlyContent(
  content: readonly MessageContent[],
): boolean {
  return (
    content.length > 0 &&
    content.every((block) => block.type === "toolResponse")
  );
}

function filterDuplicateDisplayedReasoning(
  content: readonly MessageContent[],
  displayedReasoningSignatures: ReadonlySet<string>,
): readonly MessageContent[] {
  if (displayedReasoningSignatures.size === 0 || content.length === 0) {
    return content;
  }

  let firstNonDuplicateIndex = 0;
  for (const block of content) {
    const signature = getReasoningSignature(block);
    if (!signature || !displayedReasoningSignatures.has(signature)) {
      break;
    }
    firstNonDuplicateIndex += 1;
  }

  if (firstNonDuplicateIndex === 0) {
    return content;
  }

  return content.slice(firstNonDuplicateIndex);
}

function isReasoningSectionHeaderLine(line: string): boolean {
  return /^(?:\*\*[^\n*]{1,120}\*\*|#{1,6}\s+[^\n]{1,120})\s*$/.test(
    line.trim(),
  );
}

function splitReasoningContentSections(
  block: ThinkingContent | ReasoningContent,
): Array<ThinkingContent | ReasoningContent> {
  const lines = block.text.split("\n");
  const sections: string[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    const startsNewSection =
      isReasoningSectionHeaderLine(line) &&
      currentLines.some((currentLine) => currentLine.trim().length > 0);

    if (startsNewSection) {
      const section = currentLines.join("\n").trimEnd();
      if (section.trim()) {
        sections.push(section);
      }
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  const finalSection = currentLines.join("\n").trimEnd();
  if (finalSection.trim()) {
    sections.push(finalSection);
  }

  if (sections.length <= 1) {
    return [block];
  }

  return sections.map((text) => ({ ...block, text }));
}

function expandReasoningContentSections(
  content: readonly MessageContent[],
): MessageContent[] {
  const expanded: MessageContent[] = [];
  for (const block of content) {
    if (block.type === "thinking" || block.type === "reasoning") {
      expanded.push(...splitReasoningContentSections(block));
    } else {
      expanded.push(block);
    }
  }
  return expanded;
}

function compactWorkContent(
  content: readonly MessageContent[],
): MessageContent[] {
  const compacted: MessageContent[] = [];
  const displayedReasoningSignatures = new Set<string>();

  for (const block of content) {
    const blocksToCompact =
      block.type === "thinking" || block.type === "reasoning"
        ? splitReasoningContentSections(block)
        : [block];

    for (const blockToCompact of blocksToCompact) {
      const sanitizedBlock =
        blockToCompact.type === "thinking" ||
        blockToCompact.type === "reasoning"
          ? {
              ...blockToCompact,
              text: sanitizeReasoningTextForDisplay(blockToCompact.text),
            }
          : blockToCompact;
      const reasoningSignature =
        sanitizedBlock.type === "thinking" ||
        sanitizedBlock.type === "reasoning"
          ? getCanonicalReasoningSignature(sanitizedBlock.text)
          : null;
      if (reasoningSignature) {
        if (displayedReasoningSignatures.has(reasoningSignature)) {
          continue;
        }
        displayedReasoningSignatures.add(reasoningSignature);
      }

      const previous = compacted[compacted.length - 1];

      if (
        previous?.type === "text" &&
        sanitizedBlock.type === "text" &&
        previous.speech?.status === sanitizedBlock.speech?.status
      ) {
        compacted[compacted.length - 1] = {
          ...previous,
          text: `${previous.text}${sanitizedBlock.text}`,
        };
        continue;
      }

      compacted.push(sanitizedBlock);
    }
  }

  return compacted;
}

function buildMessageItemForContent({
  message,
  content,
  isStreaming,
  idSuffix,
  responseStartMessageId,
  preserveMessageContext = false,
}: {
  message: Message;
  content: readonly MessageContent[];
  isStreaming: boolean;
  idSuffix: string;
  responseStartMessageId?: string;
  preserveMessageContext?: boolean;
}): TranscriptMessageItem {
  const syntheticMessage: Message = {
    ...message,
    id: `${message.id}:${idSuffix}`,
    content: preserveMessageContext ? message.content : [...content],
  };
  const revisions = buildMessageRevisions(syntheticMessage, content);
  const measurementDecision = getMessageMeasurementDecision({
    message: syntheticMessage,
    visibleContent: content,
    isStreaming,
  });

  return createMessageItem({
    message: syntheticMessage,
    visibleContent: content,
    blockIds: getBlockIds(content),
    searchableText: getSearchableText(syntheticMessage, content),
    isStreaming,
    revisions,
    estimatedHeight: estimateMessageHeight(syntheticMessage, content),
    measurementDecision,
    responseStartMessageId,
  });
}

function isWorkContent(block: MessageContent): boolean {
  return isToolContent(block) || isReasoningContent(block);
}

function getCompanionIdentity(block: MessageContent): string {
  if (
    block.type === "mcpApp" ||
    block.type === "actionRequired" ||
    block.type === "toolRequest" ||
    block.type === "toolResponse"
  ) {
    return `${block.type}-${encodeURIComponent(block.id)}`;
  }
  return `${block.type}-${stableValueRevision(block)}`;
}

function compactTextContent(
  content: readonly TextLikeContent[],
): MessageContent[] {
  const compacted: TextLikeContent[] = [];
  for (const block of content) {
    const text = block.text.trim();
    if (!text) continue;

    const previous = compacted[compacted.length - 1];
    if (previous && previous.speech?.status === block.speech?.status) {
      compacted[compacted.length - 1] = {
        ...previous,
        text: `${previous.text}\n\n${text}`,
      };
      continue;
    }

    compacted.push({ ...block, text });
  }

  return compacted;
}

function estimateAgentWorkHeight(content: readonly MessageContent[]): number {
  const workCount = content.filter(
    (block) => isToolContent(block) || isReasoningContent(block),
  ).length;
  return Math.min(420, Math.max(96, 72 + workCount * 28));
}

function buildAgentWorkItem({
  message,
  content,
  isStreaming,
  hasFinalAnswer = false,
  idSuffix = "agent-work",
}: {
  message: Message;
  content: readonly MessageContent[];
  isStreaming: boolean;
  hasFinalAnswer?: boolean;
  idSuffix?: string;
}): TranscriptAgentWorkItem {
  const workMessage: Message = {
    ...message,
    id: `${message.id}:work:${idSuffix}`,
    content: [...content],
  };
  const revisions = buildMessageRevisions(workMessage, content);
  const thoughtCount = content.filter(isReasoningContent).length;
  const toolCount = content.filter(
    (block) => block.type === "toolRequest",
  ).length;
  const textCount = content.filter(isTextContent).length;
  const isActiveWork =
    isStreaming ||
    content.some(
      (block) =>
        block.type === "toolRequest" &&
        (block.status === "pending" || block.status === "in_progress"),
    );
  const measurementDecision = classifyTranscriptMeasurementPolicy({
    rowKind: "agent-work",
    message: workMessage,
    content,
    capabilities: {
      stateful: true,
      hasToolContent: toolCount > 0,
      hasReasoningContent: thoughtCount > 0,
      hasDynamicAsyncLayout: true,
      hasActiveToolWork: isActiveWork,
      hasActiveTimer: isActiveWork,
      hasStreamingContent: isStreaming,
    },
  });

  const rowId = `message:${message.id}:${idSuffix}`;
  return {
    itemId: rowId,
    kind: "agent-work",
    rowId,
    messageId: message.id,
    message: workMessage,
    workId: rowId,
    content,
    isActiveWork,
    hasFinalAnswer,
    thoughtCount,
    toolCount,
    textCount,
    renderRevision: [
      "agent-work",
      message.id,
      idSuffix,
      hasFinalAnswer ? "answered" : "unanswered",
      revisions.renderRevision,
    ].join(":"),
    heightRevision: [
      "agent-work-height",
      message.id,
      idSuffix,
      revisions.heightRevision,
    ].join(":"),
    estimatedHeight: estimateAgentWorkHeight(content),
    capabilities: measurementDecision.capabilities,
    measurementPolicy: measurementDecision.policy,
    layoutPendingPolicy: measurementDecision.layoutPendingPolicy,
    measurementSafetyReasons: measurementDecision.reasons,
    anchorPriority: isStreaming ? "streaming" : "stable",
    keepAlivePriority: measurementDecision.keepAlivePriority,
  };
}

function buildAgentWorkItems({
  message,
  visibleContent,
  isStreaming,
}: {
  message: Message;
  visibleContent: readonly MessageContent[];
  isStreaming: boolean;
}): readonly TranscriptItemDescriptor[] | null {
  if (message.role !== "assistant" || visibleContent.length === 0) {
    return null;
  }

  // Agent work is one semantic part of an assistant turn, not an all-or-nothing
  // rendering mode for the message. Images, MCP apps, notifications, and future
  // companion blocks should stay in sequence without ejecting reasoning and
  // tools back to the legacy whole-message renderer.
  const workAndTextEntries = visibleContent.flatMap((block, index) =>
    isWorkContent(block) || isTextContent(block) ? [{ block, index }] : [],
  );
  if (!workAndTextEntries.some(({ block }) => isWorkContent(block))) {
    return null;
  }

  let answerEndEntryIndex = workAndTextEntries.length - 1;
  while (
    !isStreaming &&
    answerEndEntryIndex >= 0 &&
    isReasoningContent(
      workAndTextEntries[answerEndEntryIndex]?.block as MessageContent,
    )
  ) {
    answerEndEntryIndex -= 1;
  }

  const answerEntries: typeof workAndTextEntries = [];
  if (
    !isStreaming &&
    answerEndEntryIndex >= 0 &&
    isTextContent(
      workAndTextEntries[answerEndEntryIndex]?.block as MessageContent,
    )
  ) {
    // Only adjacent text blocks belong to the same answer. A companion block is
    // a real sequence boundary, so text on its other side stays in agent work.
    let expectedIndex = workAndTextEntries[answerEndEntryIndex]?.index;
    for (let index = answerEndEntryIndex; index >= 0; index -= 1) {
      const entry = workAndTextEntries[index];
      if (
        !entry ||
        !isTextContent(entry.block) ||
        entry.index !== expectedIndex
      ) {
        break;
      }
      answerEntries.unshift(entry);
      expectedIndex -= 1;
    }
  }
  const answerIndexes = new Set(answerEntries.map(({ index }) => index));
  const finalTextContent = compactTextContent(
    answerEntries.map(({ block }) => block).filter(isTextContent),
  );

  const positionedItems: Array<{
    index: number;
    item: TranscriptItemDescriptor;
  }> = [];
  const workEntries = workAndTextEntries.filter(
    ({ index }) => !answerIndexes.has(index),
  );
  const workEntryGroups: Array<typeof workEntries> = [];
  for (const entry of workEntries) {
    const currentGroup = workEntryGroups[workEntryGroups.length - 1];
    const previousEntry = currentGroup?.[currentGroup.length - 1];
    if (!previousEntry || entry.index !== previousEntry.index + 1) {
      workEntryGroups.push([entry]);
    } else {
      currentGroup.push(entry);
    }
  }

  const finalAnswerIndex = answerEntries[0]?.index;

  workEntryGroups.forEach((entries, groupIndex) => {
    const content = compactWorkContent(entries.map(({ block }) => block));
    const sourceIndex = entries[0]?.index ?? 0;
    // Some providers persist reasoning summaries after their final text. Move
    // that work directly before the answer so the answer keeps its source-order
    // relationship with companion content such as images and MCP apps. Groups
    // are built in ascending source order and the sort below is stable, so
    // sharing one position keeps multiple trailing groups in sequence.
    const isTrailingWork =
      finalAnswerIndex !== undefined && sourceIndex > finalAnswerIndex;
    positionedItems.push({
      index: isTrailingWork ? finalAnswerIndex - 0.5 : sourceIndex,
      item: buildAgentWorkItem({
        message,
        content,
        isStreaming,
        hasFinalAnswer:
          groupIndex === workEntryGroups.length - 1 &&
          finalTextContent.length > 0,
        idSuffix:
          workEntryGroups.length === 1
            ? "agent-work"
            : `agent-work-${groupIndex}`,
      }),
    });
  });

  if (finalTextContent.length > 0) {
    positionedItems.push({
      index: answerEntries[0]?.index ?? visibleContent.length,
      item: buildMessageItemForContent({
        message,
        content: finalTextContent,
        isStreaming,
        idSuffix: "answer",
        responseStartMessageId: message.id,
      }),
    });
  }

  const companionIdentityCounts = new Map<string, number>();
  for (const [index, block] of visibleContent.entries()) {
    if (isWorkContent(block) || isTextContent(block)) {
      continue;
    }
    const identity = getCompanionIdentity(block);
    const occurrence = companionIdentityCounts.get(identity) ?? 0;
    companionIdentityCounts.set(identity, occurrence + 1);
    const idSuffix = `companion-${identity}${occurrence ? `-${occurrence}` : ""}`;
    positionedItems.push({
      index,
      item: buildMessageItemForContent({
        message,
        content: [block],
        isStreaming,
        idSuffix,
        responseStartMessageId: message.id,
        preserveMessageContext: block.type === "mcpApp",
      }),
    });
  }

  return positionedItems
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item);
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

type ParsedBlock =
  | { kind: "text"; text: string; isHeading: boolean }
  | {
      kind: "code";
      fenceOpener: string;
      codeLines: readonly string[];
      closingFence: string;
      language: string | null;
    };

type AssistantFragmentChunk = {
  text: string;
  isCodeContinuationChunk: boolean;
  startsWithHeading: boolean;
};

function isCodeFenceEnd(
  line: string,
  fenceChar: string,
  minFenceLength: number,
): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  let fenceLength = 0;
  while (i < line.length && line[i] === fenceChar) {
    fenceLength += 1;
    i += 1;
  }
  if (fenceLength < minFenceLength) {
    return false;
  }
  while (i < line.length) {
    if (line[i] !== " " && line[i] !== "\t") {
      return false;
    }
    i += 1;
  }
  return true;
}

function isMarkdownHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

function isMarkdownListLine(line: string): boolean {
  return /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isMarkdownBlockquote(line: string): boolean {
  return /^\s{0,3}>\s?/.test(line);
}

function isMarkdownThematicBreak(line: string): boolean {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isMarkdownSetextUnderline(line: string): boolean {
  return /^\s{0,3}(?:=+|-+)\s*$/.test(line);
}

function isMarkdownHtmlBlock(line: string): boolean {
  return /^\s{0,3}<\/?[A-Za-z][^>]*>\s*$/.test(line);
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

function isMarkdownTableStart(
  lines: readonly string[],
  index: number,
): boolean {
  return Boolean(
    isPotentialMarkdownTableRow(lines[index] ?? "") &&
      isPotentialMarkdownTableRow(lines[index + 1] ?? "") &&
      isMarkdownTableDelimiterLine(lines[index + 1] ?? ""),
  );
}

const FENCE_START_PATTERN = /^[ \t]*(`{3,}|~{3,})/;

function isMarkdownSpecialBlockStart(
  lines: readonly string[],
  index: number,
): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    FENCE_START_PATTERN.test(line) ||
      isMarkdownHeading(line) ||
      isMarkdownListLine(line) ||
      isMarkdownBlockquote(line) ||
      isMarkdownThematicBreak(line) ||
      isMarkdownHtmlBlock(line) ||
      isMarkdownTableStart(lines, index),
  );
}

function parseMarkdownBlocks(lines: readonly string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = FENCE_START_PATTERN.exec(line);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1] ?? "```";
      const fenceChar = fenceMarker[0] ?? "`";
      const minFenceLength = fenceMarker.length;
      const infoString = line
        .slice(line.indexOf(fenceMarker) + fenceMarker.length)
        .trim();
      const language = infoString.split(/\s+/)[0] || null;
      const fenceOpener = line;
      const codeLines: string[] = [];
      index += 1;
      let closingFence = fenceMarker;
      while (index < lines.length) {
        const nextLine = lines[index] ?? "";
        if (isCodeFenceEnd(nextLine, fenceChar, minFenceLength)) {
          closingFence = nextLine;
          index += 1;
          break;
        }
        codeLines.push(nextLine);
        index += 1;
      }
      blocks.push({
        kind: "code",
        fenceOpener,
        codeLines,
        closingFence,
        language,
      });
      continue;
    }

    // Table
    if (isMarkdownTableStart(lines, index)) {
      const tableLines = [line, lines[index + 1] ?? ""];
      index += 2;
      while (
        index < lines.length &&
        isPotentialMarkdownTableRow(lines[index] ?? "")
      ) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({
        kind: "text",
        text: tableLines.join("\n"),
        isHeading: false,
      });
      continue;
    }

    // ATX heading
    if (isMarkdownHeading(line)) {
      blocks.push({ kind: "text", text: line, isHeading: true });
      index += 1;
      continue;
    }

    // Thematic break
    if (isMarkdownThematicBreak(line)) {
      blocks.push({ kind: "text", text: line, isHeading: false });
      index += 1;
      continue;
    }

    // List
    if (isMarkdownListLine(line)) {
      const listLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? "";
        if (
          isMarkdownListLine(nextLine) ||
          /^\s{2,}\S/.test(nextLine) ||
          !nextLine.trim()
        ) {
          listLines.push(nextLine);
          index += 1;
        } else {
          break;
        }
      }
      while (listLines.length > 0 && !listLines[listLines.length - 1]?.trim()) {
        listLines.pop();
      }
      if (listLines.length > 0) {
        blocks.push({
          kind: "text",
          text: listLines.join("\n"),
          isHeading: false,
        });
      }
      continue;
    }

    // Blockquote
    if (isMarkdownBlockquote(line)) {
      const bqLines = [line];
      index += 1;
      while (index < lines.length && isMarkdownBlockquote(lines[index] ?? "")) {
        bqLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "text", text: bqLines.join("\n"), isHeading: false });
      continue;
    }

    // HTML block
    if (isMarkdownHtmlBlock(line)) {
      const htmlLines = [line];
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim()) {
        htmlLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({
        kind: "text",
        text: htmlLines.join("\n"),
        isHeading: false,
      });
      continue;
    }

    // Paragraph (may become setext heading)
    const paraLines = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !isMarkdownSetextUnderline(lines[index] ?? "") &&
      !isMarkdownSpecialBlockStart(lines, index)
    ) {
      paraLines.push(lines[index] ?? "");
      index += 1;
    }
    const isSetextHeading =
      index < lines.length && isMarkdownSetextUnderline(lines[index] ?? "");
    if (isSetextHeading) {
      paraLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({
      kind: "text",
      text: paraLines.join("\n"),
      isHeading: isSetextHeading,
    });
  }

  return blocks;
}

function expandCodeBlockChunks(
  block: Extract<ParsedBlock, { kind: "code" }>,
): AssistantFragmentChunk {
  const { fenceOpener, codeLines, closingFence } = block;
  return {
    text: [fenceOpener, ...codeLines, closingFence].join("\n"),
    isCodeContinuationChunk: false,
    startsWithHeading: false,
  };
}

function findBlankLineSplitIndex(
  lines: readonly string[],
  startIndex: number,
  targetIndex: number,
): number {
  const maxIndex = Math.min(
    lines.length - 1,
    targetIndex + ASSISTANT_FRAGMENT_BLANK_LINE_SEARCH_RADIUS,
  );
  const minIndex = Math.max(
    startIndex + 1,
    targetIndex - ASSISTANT_FRAGMENT_BLANK_LINE_SEARCH_RADIUS,
  );
  for (let i = targetIndex; i <= maxIndex; i += 1) {
    if (!lines[i]?.trim()) {
      return i + 1;
    }
  }
  for (let i = targetIndex - 1; i >= minIndex; i -= 1) {
    if (!lines[i]?.trim()) {
      return i + 1;
    }
  }
  return targetIndex;
}

function splitTextBlockIntoChunks(
  block: Extract<ParsedBlock, { kind: "text" }>,
): AssistantFragmentChunk[] {
  const { text, isHeading } = block;
  const lines = text.split(/\n/);
  const isTable =
    lines.length >= 2 &&
    isPotentialMarkdownTableRow(lines[0] ?? "") &&
    isMarkdownTableDelimiterLine(lines[1] ?? "");
  if (lines.length <= ASSISTANT_FRAGMENT_TARGET_LINE_COUNT || isTable) {
    return [
      { text, isCodeContinuationChunk: false, startsWithHeading: isHeading },
    ];
  }
  const chunks: AssistantFragmentChunk[] = [];
  let startIndex = 0;
  while (startIndex < lines.length) {
    const remaining = lines.length - startIndex;
    if (remaining <= ASSISTANT_FRAGMENT_TARGET_LINE_COUNT) {
      chunks.push({
        text: lines.slice(startIndex).join("\n"),
        isCodeContinuationChunk: false,
        startsWithHeading: isHeading && startIndex === 0,
      });
      break;
    }
    const splitIndex = findBlankLineSplitIndex(
      lines,
      startIndex,
      startIndex + ASSISTANT_FRAGMENT_TARGET_LINE_COUNT,
    );
    chunks.push({
      text: lines.slice(startIndex, splitIndex).join("\n"),
      isCodeContinuationChunk: false,
      startsWithHeading: isHeading && startIndex === 0,
    });
    startIndex = splitIndex;
  }
  return chunks;
}

function splitAssistantTextIntoChunks(
  text: string,
): readonly AssistantFragmentChunk[] | null {
  const lines = text.split(/\n/);
  const blocks = parseMarkdownBlocks(lines);
  const hasCodeBlocks = blocks.some((b) => b.kind === "code");

  if (!hasCodeBlocks && lines.length < ASSISTANT_FRAGMENT_MIN_LINE_COUNT) {
    return null;
  }
  if (hasCodeBlocks && lines.length < ASSISTANT_FRAGMENT_CODE_MIN_LINE_COUNT) {
    return null;
  }

  const chunks: AssistantFragmentChunk[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      chunks.push(expandCodeBlockChunks(block));
    } else {
      chunks.push(...splitTextBlockIntoChunks(block));
    }
  }

  return chunks.length > 1 ? chunks : null;
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
  if (!messages.some(needsVoiceTranscriptSanitization)) {
    return messages.filter(isVisibleTranscriptMessage);
  }

  return messages.flatMap((message, index) => {
    if (!isVisibleTranscriptMessage(message)) return [];
    const isEmptyResponseFallback =
      (message.role === "assistant" &&
        isVoiceConversationEmptyResponse(getTextContent(message))) ||
      message.content.some(
        (content) =>
          content.type === "systemNotification" &&
          isVoiceConversationEmptyResponse(content.text),
      );
    if (!isEmptyResponseFallback) {
      return [sanitizeVoiceSpeechFallback(message)];
    }

    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const priorMessage = messages[prior];
      if (priorMessage?.role !== "user") continue;
      return isVoiceConversationUserTurn(priorMessage) ? [] : [message];
    }
    return [message];
  });
}

function needsVoiceTranscriptSanitization(message: Message): boolean {
  return (
    isVoiceConversationUserTurn(message) ||
    message.content.some(
      (content) => content.type === "text" && content.speech !== undefined,
    )
  );
}

function sanitizeVoiceSpeechFallback(message: Message): Message {
  const hasSpeech = message.content.some(
    (content) => content.type === "text" && content.speech !== undefined,
  );
  if (!hasSpeech) return message;

  let changed = false;
  const content: MessageContent[] = [];
  for (const block of message.content) {
    if (
      block.type === "systemNotification" &&
      isVoiceConversationEmptyResponse(block.text)
    ) {
      changed = true;
      continue;
    }
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!block.speech && isVoiceConversationEmptyResponse(block.text)) {
      changed = true;
      continue;
    }
    const text = stripVoiceConversationEmptyResponseSuffix(block.text);
    if (text === block.text) {
      content.push(block);
      continue;
    }
    changed = true;
    if (text) content.push({ ...block, text });
  }

  return changed ? { ...message, content } : message;
}

function isVoiceConversationUserTurn(message: Message): boolean {
  return (
    message.metadata?.origin === "voice_conversation" ||
    (message.role === "user" &&
      message.content.some(
        (content) =>
          content.type === "text" &&
          content.text.trimStart().startsWith("[Voice transcript] "),
      ))
  );
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
