// Ported from the prototype's Dart ACP client. Same shapes, TS-idiomatic.

export type ChatRole = "user" | "assistant" | "system";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolActivity {
  id: string;
  name: string;
  status: string;
  result?: string;
}

export interface ToolContent {
  type: "tool";
  tool: ToolActivity;
}

export interface SystemContent {
  type: "system";
  text: string;
}

export type ChatContent =
  | TextContent
  | ImageContent
  | ToolContent
  | SystemContent;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  content: ChatContent[];
  isStreaming: boolean;
}

export function plainText(message: ChatMessage): string | null {
  const text = message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text.length === 0 ? null : text;
}

/** Per-session transient state that is not part of the transcript itself. */
export interface SessionRuntime {
  isOpening: boolean;
  isReplaying: boolean;
  hasTailSnapshot: boolean;
  hasAuthoritativeReplay: boolean;
  queuedPromptCount: number;
  optimisticUserMessageIds: Set<string>;
  snapshotMessageIds: Set<string>;
  activeRunId: string | null;
  streamingMessageId: string | null;
  errorMessage: string | null;
}

export function emptyRuntime(
  overrides: Partial<SessionRuntime> = {},
): SessionRuntime {
  return {
    isOpening: false,
    isReplaying: false,
    hasTailSnapshot: false,
    hasAuthoritativeReplay: false,
    queuedPromptCount: 0,
    optimisticUserMessageIds: new Set(),
    snapshotMessageIds: new Set(),
    activeRunId: null,
    streamingMessageId: null,
    errorMessage: null,
    ...overrides,
  };
}

export interface QueuedPrompt {
  id: string;
  text: string;
  preamble?: string;
}

/** Metadata surfaced while applying updates. */
export interface TranscriptApplyResult {
  subtitle?: string;
  sessionTitle?: string;
  updatedAt?: number;
  lastMessageAt?: number;
  isArchived: boolean;
  hasMessageActivity: boolean;
}

export function emptyApplyResult(): TranscriptApplyResult {
  return { isArchived: false, hasMessageActivity: false };
}

export function mergeApplyResult(
  into: TranscriptApplyResult,
  other: TranscriptApplyResult,
): void {
  into.subtitle = other.subtitle ?? into.subtitle;
  into.sessionTitle = other.sessionTitle ?? into.sessionTitle;
  into.updatedAt = latest(into.updatedAt, other.updatedAt);
  into.lastMessageAt = latest(into.lastMessageAt, other.lastMessageAt);
  into.isArchived = into.isArchived || other.isArchived;
  into.hasMessageActivity = into.hasMessageActivity || other.hasMessageActivity;
}

function latest(lhs?: number, rhs?: number): number | undefined {
  if (lhs !== undefined && rhs !== undefined) return Math.max(lhs, rhs);
  return lhs ?? rhs;
}
