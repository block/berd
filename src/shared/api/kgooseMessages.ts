import type {
  Message,
  MessageContent,
  MessageRole,
  ToolCallStatus,
} from "@/shared/types/messages";
import { normalizeKgooseJson } from "./kgooseJson";
import { getToolLabel } from "./toolLabels";

export type KgooseSessionStatus =
  | "initialized"
  | "idle"
  | "processing"
  | "needClientInput"
  | "terminated"
  | "cancelling"
  | "waitingForPermission"
  | "unknown";

export interface KgooseMessageContent {
  type?: string | number;
  id?: string;
  text?: { text?: string } | string;
  toolCall?: {
    status?: string | number;
    value?: {
      name?: string;
      arguments?: unknown;
    };
  };
  toolResult?: {
    status?: string | number;
    value?: {
      content?: unknown[];
      structuredContent?: unknown;
      isError?: boolean;
    };
  };
  toolRequest?: {
    id?: string;
    status?: string | number;
    value?: {
      name?: string;
      arguments?: unknown;
      tooltip?: string;
      needsApproval?: boolean;
    };
    name?: string;
    arguments?: unknown;
    tooltip?: string;
    tooltipCategory?: string;
    error?: string;
  };
  toolResponse?: {
    id?: string;
    status?: string | number;
    results?: unknown[];
    error?: string;
    extensionName?: string;
  };
  thinking?: { thinking?: string; text?: string } | string;
  redactedThinking?: { data?: string };
  summary?: { text?: string } | string;
}

interface KgooseMessage {
  id?: string;
  role?: string | number;
  created?: string | number;
  content?: KgooseMessageContent[];
  messageContents?: KgooseMessageContent[];
  deleted?: boolean;
  hidden?: boolean;
  llmCallErrorInfo?: {
    isError?: boolean;
    cause?: string;
  };
}

export interface KgooseMessagesResponse {
  messages: Message[];
  nextCursor?: string;
  status: KgooseSessionStatus;
  sessionName?: string;
}

export interface KgooseMessageDelta {
  streamingMessageId?: string;
  messageContent?: KgooseMessageContent;
  isFinal?: boolean;
  isStart?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return asRecord(normalizeKgooseJson(parsed));
  } catch {
    return {};
  }
}

function enumLabel(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizedStatus(value: string | number | undefined): string {
  return enumLabel(value).toLowerCase();
}

function mapToolStatus(
  value: string | number | undefined,
  fallback: ToolCallStatus,
): ToolCallStatus {
  const normalized = normalizedStatus(value);
  if (!normalized) return fallback;
  // Match broad kgoose enum labels by precedence: failure states should not be
  // masked by later success/progress words in composite statuses.
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("stop") || normalized.includes("cancel")) {
    return "stopped";
  }
  if (
    normalized.includes("running") ||
    normalized.includes("progress") ||
    normalized.includes("processing")
  ) {
    return "in_progress";
  }
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized.includes("done")
  ) {
    return "completed";
  }
  if (normalized.includes("pending") || normalized.includes("waiting")) {
    return "pending";
  }
  return fallback;
}

function isErrorStatus(value: string | number | undefined): boolean {
  return mapToolStatus(value, "completed") === "failed";
}

function mapRole(value: string | number | undefined): MessageRole {
  const normalized = enumLabel(value).toLowerCase();
  if (normalized.includes("user") || value === 1) return "user";
  if (normalized.includes("system") || value === 3) return "system";
  return "assistant";
}

function mapTimestamp(value: string | number | undefined): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Goose's JSON session export uses Unix seconds while the messages API
    // uses milliseconds. Normalize both into the renderer's millisecond clock.
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Date.now();
}

function getNestedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.text === "string") return value.text;
  if (isRecord(value) && typeof value.thinking === "string") {
    return value.thinking;
  }
  return "";
}

function getToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return "";

  const text = result.text;
  if (typeof text === "string") return text;
  if (isRecord(text) && typeof text.text === "string") return text.text;
  return "";
}

function getToolResponseText(results: unknown[] | undefined): string {
  return (results ?? [])
    .map(getToolResultText)
    .filter((value) => value.trim())
    .join("\n");
}

function toolResponsePayload(
  response: NonNullable<KgooseMessageContent["toolResponse"]>,
) {
  return {
    id: response.id,
    status: response.status,
    extensionName: response.extensionName,
    error: response.error,
    results: response.results ?? [],
  };
}

export function mapKgooseMessageContent(
  content: KgooseMessageContent,
  index: number,
): MessageContent | null {
  const type = enumLabel(content.type).toUpperCase();

  if (content.text || type.includes("TEXT")) {
    const text = getNestedText(content.text);
    return { type: "text", text };
  }

  if (
    content.toolRequest ||
    content.toolCall ||
    type.includes("TOOL_REQUEST") ||
    type.includes("TOOLREQUEST")
  ) {
    const request: NonNullable<KgooseMessageContent["toolRequest"]> =
      content.toolRequest ??
      (content.toolCall
        ? {
            id: content.id,
            status: content.toolCall.status,
            value: content.toolCall.value,
          }
        : {});
    const tool = isRecord(request.value) ? request.value : {};
    const toolName =
      typeof tool.name === "string"
        ? tool.name
        : typeof request.name === "string"
          ? request.name
          : "tool request";
    const args = parseArguments(tool.arguments ?? request.arguments);

    // Display the human-readable label for known tools while keeping `toolName`
    // and `extensionName` set to the raw `namespace__tool` id — downstream
    // automation logic keys off those raw fields, not the display `name`.
    return {
      type: "toolRequest",
      id: request.id ?? `tool-request-${index}`,
      name: getToolLabel(toolName),
      toolName,
      extensionName: toolName.split("__")[0],
      arguments: args,
      status: mapToolStatus(request.status, "pending"),
    };
  }

  if (
    content.toolResponse ||
    content.toolResult ||
    type.includes("TOOL_RESPONSE") ||
    type.includes("TOOLRESPONSE")
  ) {
    const exportedResult = content.toolResult?.value;
    const response =
      content.toolResponse ??
      (content.toolResult
        ? {
            id: content.id,
            status: content.toolResult.status,
            results: exportedResult?.content,
            error: exportedResult?.isError ? "Tool call failed" : undefined,
          }
        : {});
    const isError = isErrorStatus(response.status) || Boolean(response.error);
    const result = response.error ?? getToolResponseText(response.results);

    return {
      type: "toolResponse",
      id: response.id ?? `tool-response-${index}`,
      name: getToolLabel(response.extensionName ?? "tool response"),
      result,
      structuredContent: toolResponsePayload(response),
      isError,
    };
  }

  if (content.redactedThinking || type.includes("REDACTED_THINKING")) {
    return { type: "redactedThinking" };
  }

  if (content.thinking || type.includes("THINKING")) {
    return {
      type: "thinking",
      text: getNestedText(content.thinking),
    };
  }

  if (content.summary || type.includes("SUMMARY")) {
    const text = getNestedText(content.summary);
    return text ? { type: "text", text } : null;
  }

  return null;
}

function mapKgooseMessage(message: KgooseMessage): Message | null {
  if (message.deleted || message.hidden) return null;
  const contents = message.content ?? message.messageContents ?? [];
  const mappedContent = contents
    .map(mapKgooseMessageContent)
    .filter((content): content is MessageContent => Boolean(content))
    .filter((content) => {
      return content.type !== "text" || content.text.trim().length > 0;
    });

  if (message.llmCallErrorInfo?.isError && message.llmCallErrorInfo.cause) {
    mappedContent.push({
      type: "systemNotification",
      notificationType: "error",
      text: message.llmCallErrorInfo.cause,
    });
  }

  if (!mappedContent.length) return null;

  return {
    id: message.id ?? crypto.randomUUID(),
    role: mapRole(message.role),
    created: mapTimestamp(message.created),
    content: mappedContent,
    metadata: {
      userVisible: true,
      agentVisible: true,
    },
  };
}

function openToolRequestIds(content: MessageContent[]): string[] {
  const responseIds = new Set(
    content
      .filter((item) => item.type === "toolResponse")
      .map((item) => item.id),
  );

  const requestIds: string[] = [];
  for (const item of content) {
    if (item.type === "toolRequest" && !responseIds.has(item.id)) {
      requestIds.push(item.id);
    }
  }
  return requestIds;
}

// Historical kgoose sessions can store a tool response in its own assistant
// message. Merge those standalone responses into the prior matching request so
// MessageTimeline renders one completed tool card instead of a pending request
// followed by an orphaned result.
function mergeToolResponsesIntoRequests(messages: Message[]): Message[] {
  const merged: Message[] = [];
  const openRequestMessageIndexes = new Map<string, number>();

  for (const message of messages) {
    const remainingContent: MessageContent[] = [];

    for (const content of message.content) {
      if (content.type !== "toolResponse") {
        remainingContent.push(content);
        continue;
      }

      const targetIndex = openRequestMessageIndexes.get(content.id);
      if (targetIndex !== undefined) {
        const target = merged[targetIndex];
        merged[targetIndex] = {
          ...target,
          content: [...target.content, content],
        };
        openRequestMessageIndexes.delete(content.id);
        continue;
      }

      remainingContent.push(content);
    }

    if (remainingContent.length > 0) {
      const messageIndex = merged.length;
      merged.push({ ...message, content: remainingContent });
      for (const toolRequestId of openToolRequestIds(remainingContent)) {
        openRequestMessageIndexes.set(toolRequestId, messageIndex);
      }
    }
  }

  return merged;
}

function statusFromKgoose(
  value: string | number | undefined,
): KgooseSessionStatus {
  const normalized = enumLabel(value).toLowerCase();
  if (normalized.includes("initialized") || value === 1) return "initialized";
  if (normalized.includes("idle") || value === 2) return "idle";
  if (normalized.includes("processing") || value === 3) return "processing";
  if (normalized.includes("need_client_input") || value === 4) {
    return "needClientInput";
  }
  if (normalized.includes("terminated") || value === 5) return "terminated";
  if (normalized.includes("cancelling") || value === 6) return "cancelling";
  if (normalized.includes("waiting_for_permission") || value === 7) {
    return "waitingForPermission";
  }
  return "unknown";
}

export function asKgooseMessagesResponse(
  value: unknown,
): KgooseMessagesResponse {
  const normalized = normalizeKgooseJson(value);
  const record = asRecord(normalized);
  const messages = recordArray(record.messages)
    .map((message) => mapKgooseMessage(message as KgooseMessage))
    .filter((message): message is Message => Boolean(message));

  return {
    messages: mergeToolResponsesIntoRequests(messages),
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : undefined,
    status: statusFromKgoose(record.status as string | number | undefined),
    sessionName:
      typeof record.sessionName === "string" ? record.sessionName : undefined,
  };
}

/** Parse the JSON emitted by `goose session export` into timeline messages. */
export function messagesFromKgooseSessionExport(value: unknown): Message[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const normalized = normalizeKgooseJson(parsed);
  const record = asRecord(normalized);
  return asKgooseMessagesResponse({ messages: record.conversation }).messages;
}

export function asKgooseStreamResponse(
  value: unknown,
):
  | { type: "messages"; response: KgooseMessagesResponse }
  | { type: "delta"; delta: KgooseMessageDelta }
  | null {
  const normalized = normalizeKgooseJson(value);
  const record = asRecord(normalized);
  if (record.getMessagesResponse) {
    return {
      type: "messages",
      response: asKgooseMessagesResponse(record.getMessagesResponse),
    };
  }
  if (record.deltaMessageContent) {
    const deltaRecord = asRecord(record.deltaMessageContent);
    const messageContent = asRecord(deltaRecord.messageContent);
    if (
      typeof deltaRecord.streamingMessageId !== "string" ||
      !deltaRecord.streamingMessageId.trim() ||
      !Object.keys(messageContent).length
    ) {
      return null;
    }
    return {
      type: "delta",
      delta: {
        streamingMessageId: deltaRecord.streamingMessageId,
        messageContent: messageContent as KgooseMessageContent,
        isFinal:
          typeof deltaRecord.isFinal === "boolean"
            ? deltaRecord.isFinal
            : undefined,
        isStart:
          typeof deltaRecord.isStart === "boolean"
            ? deltaRecord.isStart
            : undefined,
      },
    };
  }
  return null;
}

export function applyKgooseMessageDelta(
  messages: Message[],
  delta: KgooseMessageDelta,
): Message[] {
  const messageId = delta.streamingMessageId;
  if (!messageId || !delta.messageContent) return messages;
  const mappedContent = mapKgooseMessageContent(delta.messageContent, 0);
  if (!mappedContent || mappedContent.type !== "text") return messages;
  const text = mappedContent.text;

  const existingIndex = messages.findIndex(
    (message) => message.id === messageId,
  );
  if (existingIndex === -1) {
    return [
      ...messages,
      {
        id: messageId,
        role: "assistant",
        created: Date.now(),
        content: [{ type: "text", text }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: delta.isFinal ? "completed" : "inProgress",
        },
      },
    ];
  }

  return messages.map((message, index) => {
    if (index !== existingIndex) return message;
    const content = [...message.content];
    const lastTextIndex = content.findLastIndex((item) => item.type === "text");
    if (lastTextIndex === -1) {
      content.push({ type: "text", text });
    } else if (delta.isStart) {
      const existingText = content[lastTextIndex];
      if (existingText.type === "text" && existingText.text === text) {
        return message;
      }
      content.push({ type: "text", text });
    } else {
      const existingText = content[lastTextIndex];
      if (existingText.type === "text") {
        content[lastTextIndex] = {
          ...existingText,
          text: `${existingText.text}${text}`,
        };
      }
    }
    return {
      ...message,
      content,
      metadata: {
        ...message.metadata,
        completionStatus: delta.isFinal ? "completed" : "inProgress",
      },
    };
  });
}
