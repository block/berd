// Ported 1:1 from the prototype's lib/chat/chat_transcript_reducer.dart (itself ported
// from the original Swift prototype), including the optimistic-echo and
// snapshot-reconciliation rules encoded in its tests.

import type { AcpNotification, AcpUpdate } from "./acpNotification";
import {
  emptyApplyResult,
  emptyRuntime,
  mergeApplyResult,
  plainText,
  type ChatContent,
  type ChatMessage,
  type ImageContent,
  type QueuedPrompt,
  type SessionRuntime,
  type ToolContent,
  type TranscriptApplyResult,
} from "./chatModels";

const normalized = (text: string): string => text.trim();

let uuidCounter = 0;
const generatedId = (): string => `generated-${Date.now()}-${uuidCounter++}`;

export interface AuthoritativeReplayOutcome {
  messages: ChatMessage[];
  runtime: SessionRuntime;
  result: TranscriptApplyResult;
  queuedPrompts: QueuedPrompt[];
}

export class ChatTranscriptReducer {
  messages: ChatMessage[];
  runtime: SessionRuntime;

  constructor(args: { messages: ChatMessage[]; runtime: SessionRuntime }) {
    this.messages = args.messages;
    this.runtime = args.runtime;
  }

  /**
   * Replays `session/load` notifications into a fresh reducer, appends any
   * local prompts the replay did not already contain, and settles all
   * streaming state: replay completion must never leave replay-derived
   * active-run or progress UI alive.
   */
  static authoritativeReplay(
    notifications: AcpNotification[],
    preservingLocalPrompts: QueuedPrompt[] = [],
  ): AuthoritativeReplayOutcome {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    const mergedResult = emptyApplyResult();

    for (const notification of notifications) {
      mergeApplyResult(mergedResult, reducer.apply(notification));
    }

    const unreplayedLocalPrompts = preservingLocalPrompts.filter((prompt) => {
      return !reducer.messages.some((message) => {
        if (message.id === prompt.id) return true;
        if (message.role !== "user") return false;
        const text = plainText(message);
        return text !== null && normalized(text) === normalized(prompt.text);
      });
    });

    for (const prompt of unreplayedLocalPrompts) {
      reducer.appendLocalUserMessage({ id: prompt.id, text: prompt.text });
    }

    reducer.runtime.activeRunId = null;
    reducer.finishStreamingMessage();

    reducer.runtime.hasAuthoritativeReplay = true;
    reducer.runtime.hasTailSnapshot = false;
    reducer.runtime.isOpening = false;
    reducer.runtime.isReplaying = false;
    reducer.runtime.queuedPromptCount = unreplayedLocalPrompts.length;
    return {
      messages: reducer.messages,
      runtime: reducer.runtime,
      result: mergedResult,
      queuedPrompts: unreplayedLocalPrompts,
    };
  }

  appendLocalUserMessage(args: {
    id: string;
    text: string;
    createdAt?: number;
  }): void {
    this.finishStreamingMessage();
    this.messages.push({
      id: args.id,
      role: "user",
      createdAt: args.createdAt ?? Date.now(),
      content: [{ type: "text", text: args.text }],
      isStreaming: false,
    });
    this.runtime.optimisticUserMessageIds.add(args.id);
  }

  apply(notification: AcpNotification): TranscriptApplyResult {
    const update = notification.update;
    const result = emptyApplyResult();

    const activeRunId = update.activeRunId;
    if (activeRunId.isPresent && activeRunId.id !== null) {
      this.runtime.activeRunId = activeRunId.id;
    }

    switch (update.kind) {
      case "agent_message":
      case "agent_message_chunk": {
        const content = update.content;
        if (content !== null) {
          const messageId = this.ensureAssistantMessage(update.messageId);
          const text = textContent(content);
          if (text !== null && text.length > 0) {
            this.appendText(text, messageId);
            result.subtitle = this.plainTextFor(messageId) ?? text;
            result.hasMessageActivity = true;
          } else {
            const image = imageContent(content);
            const replayTool = toolContentFromReplay(content);
            if (image !== null) {
              this.appendContent(image, messageId);
              result.hasMessageActivity = true;
            } else if (replayTool !== null) {
              this.appendContent(replayTool, messageId);
              result.hasMessageActivity = true;
            }
          }
        }
        break;
      }

      case "user_message":
      case "user_message_chunk": {
        const content = update.content;
        if (content !== null && !isAssistantOnly(content)) {
          const text = textContent(content);
          if (text !== null) {
            this.finishStreamingMessage();
            const messageId = update.messageId ?? generatedId();
            this.appendUserText(text, messageId);
            result.subtitle = this.plainTextFor(messageId) ?? text;
            result.hasMessageActivity = true;
          } else {
            const replayTool = toolContentFromReplay(content);
            if (replayTool !== null) {
              this.finishStreamingMessage();
              const messageId = update.messageId ?? generatedId();
              this.messages.push({
                id: messageId,
                role: "assistant",
                createdAt: Date.now(),
                content: [replayTool],
                isStreaming: false,
              });
              result.hasMessageActivity = true;
            }
          }
        }
        break;
      }

      case "tool_call": {
        const messageId = this.ensureAssistantMessage(update.messageId);
        const tool = {
          id: update.toolCallId ?? generatedId(),
          name: update.title ?? "Tool",
          status: update.status ?? "in_progress",
        };
        this.appendContent({ type: "tool", tool }, messageId);
        result.subtitle = `Tool ${tool.status}: ${tool.name}`;
        result.hasMessageActivity = true;
        break;
      }

      case "tool_call_update": {
        const toolId = update.toolCallId;
        if (toolId !== null) {
          this.updateTool(toolId, update);
          result.subtitle = `Tool ${update.status ?? "updated"}`;
          result.hasMessageActivity = true;
        }
        break;
      }

      case "session_info_update": {
        const title = update.raw.title;
        result.sessionTitle = typeof title === "string" ? title : undefined;
        result.updatedAt = update.updatedAt;
        result.lastMessageAt = update.lastMessageAt;
        result.isArchived = update.archivedAt !== undefined;
        if (activeRunId.isPresent && activeRunId.id === null) {
          this.runtime.activeRunId = null;
          this.finishStreamingMessage();
        }
        break;
      }

      case "usage_update":
      case "config_option_update":
        break;

      case "task_complete":
      case "turn_complete":
      case "session_idle":
      case "agent_turn_complete":
        this.runtime.activeRunId = null;
        this.finishStreamingMessage();
        break;

      default:
        break;
    }

    return result;
  }

  private ensureAssistantMessage(preferredId: string | null): string {
    if (preferredId !== null) {
      if (!this.messages.some((message) => message.id === preferredId)) {
        this.messages.push({
          id: preferredId,
          role: "assistant",
          createdAt: Date.now(),
          content: [],
          isStreaming: true,
        });
      }
      this.runtime.streamingMessageId = preferredId;
      return preferredId;
    }

    const streamingMessageId = this.runtime.streamingMessageId;
    if (
      streamingMessageId !== null &&
      this.messages.some((message) => message.id === streamingMessageId)
    ) {
      return streamingMessageId;
    }

    const id = generatedId();
    this.messages.push({
      id,
      role: "assistant",
      createdAt: Date.now(),
      content: [],
      isStreaming: true,
    });
    this.runtime.streamingMessageId = id;
    return id;
  }

  private appendText(text: string, messageId: string): void {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return;
    const last =
      message.content.length > 0
        ? message.content[message.content.length - 1]
        : null;
    if (last !== null && last.type === "text") {
      const existing = last.text;
      // Snapshot-sourced settled messages may receive replayed echoes of
      // their own text: ignore duplicates/subsets and replace on extension
      // instead of double-appending.
      if (
        !message.isStreaming &&
        this.runtime.snapshotMessageIds.has(messageId)
      ) {
        const existingText = normalized(existing);
        const newText = normalized(text);
        if (
          existingText === newText ||
          (newText.length < existingText.length &&
            existingText.includes(newText))
        ) {
          return;
        }
        if (newText.startsWith(existingText)) {
          message.content[message.content.length - 1] = { type: "text", text };
          return;
        }
      }
      message.content[message.content.length - 1] = {
        type: "text",
        text: existing + text,
      };
    } else {
      message.content.push({ type: "text", text });
    }
  }

  private appendUserText(text: string, messageId: string): void {
    const index = this.messages.findIndex((m) => m.id === messageId);
    const message = index >= 0 ? this.messages[index] : null;
    const last =
      message && message.content.length > 0
        ? message.content[message.content.length - 1]
        : null;
    if (message && last !== null && last.type === "text") {
      const existing = last.text;
      if (
        this.runtime.optimisticUserMessageIds.has(messageId) ||
        this.runtime.snapshotMessageIds.has(messageId)
      ) {
        const existingText = normalized(existing);
        const newText = normalized(text);
        if (
          existingText === newText ||
          (newText.length < existingText.length &&
            existingText.includes(newText))
        ) {
          return;
        }
        if (newText.startsWith(existingText)) {
          message.content[message.content.length - 1] = { type: "text", text };
          return;
        }
      }
      message.content[message.content.length - 1] = {
        type: "text",
        text: existing + text,
      };
    } else if (message) {
      this.appendContent({ type: "text", text }, messageId);
    } else if (this.hasMatchingOptimisticOrSnapshotUserMessage(text)) {
      return;
    } else {
      this.messages.push({
        id: messageId,
        role: "user",
        createdAt: Date.now(),
        content: [{ type: "text", text }],
        isStreaming: false,
      });
    }
  }

  private appendContent(content: ChatContent, messageId: string): void {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return;
    message.content.push(content);
  }

  private updateTool(toolId: string, update: AcpUpdate): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      for (
        let contentIndex = 0;
        contentIndex < message.content.length;
        contentIndex++
      ) {
        const content = message.content[contentIndex];
        if (content.type !== "tool" || content.tool.id !== toolId) continue;
        const tool = { ...content.tool };
        if (update.title !== null) tool.name = update.title;
        if (update.status !== null) tool.status = update.status;
        tool.result = toolResult(update) ?? tool.result;
        message.content[contentIndex] = {
          type: "tool",
          tool,
        } satisfies ToolContent;
        return;
      }
    }

    const messageId = this.ensureAssistantMessage(update.messageId);
    this.appendContent(
      {
        type: "tool",
        tool: {
          id: toolId,
          name: update.title ?? "Tool",
          status: update.status ?? "updated",
          result: toolResult(update),
        },
      },
      messageId,
    );
  }

  private markStreaming(isStreaming: boolean, messageId: string): void {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return;
    message.isStreaming = isStreaming;
  }

  finishStreamingMessage(): void {
    const streamingMessageId = this.runtime.streamingMessageId;
    if (streamingMessageId !== null) {
      this.markStreaming(false, streamingMessageId);
    }
    this.runtime.streamingMessageId = null;
  }

  private plainTextFor(messageId: string): string | null {
    const message = this.messages.find((m) => m.id === messageId);
    return message ? plainText(message) : null;
  }

  private hasMatchingOptimisticOrSnapshotUserMessage(text: string): boolean {
    const normalizedText = normalized(text);
    return this.messages.some((message) => {
      if (message.role !== "user") return false;
      if (
        !this.runtime.optimisticUserMessageIds.has(message.id) &&
        !this.runtime.snapshotMessageIds.has(message.id)
      ) {
        return false;
      }
      const messageText = plainText(message);
      return messageText !== null && normalized(messageText) === normalizedText;
    });
  }
}

function textContent(object: Record<string, unknown>): string | null {
  if (object.type !== "text") return null;
  const text = object.text;
  return typeof text === "string" ? text : null;
}

/**
 * Hidden prompt context replayed to the client carries an
 * `annotations.audience` that does not include `user`; it must never be
 * displayed in the transcript.
 */
function isAssistantOnly(object: Record<string, unknown>): boolean {
  const annotations = object.annotations;
  if (typeof annotations !== "object" || annotations === null) return false;
  const audience = (annotations as Record<string, unknown>).audience;
  if (!Array.isArray(audience)) return false;
  return !audience
    .filter((a): a is string => typeof a === "string")
    .includes("user");
}

function toolResult(update: AcpUpdate): string | undefined {
  const result = update.raw.result;
  if (typeof result === "string") return result;
  const resultText = structuredToolText(result);
  if (resultText !== undefined) return resultText;
  const content = update.raw.content;
  if (typeof content === "object" && content !== null) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function structuredToolText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (typeof structured === "object" && structured !== null) {
    const s = structured as Record<string, unknown>;
    const stdout = typeof s.stdout === "string" ? s.stdout.trimEnd() : "";
    const stderr = typeof s.stderr === "string" ? s.stderr.trimEnd() : "";
    const exitCode = s.exit_code;
    const parts: string[] = [];
    if (typeof exitCode === "number") parts.push(`exit_code: ${exitCode}`);
    if (stdout.length > 0) parts.push(`stdout:\n${stdout}`);
    if (stderr.length > 0) parts.push(`stderr:\n${stderr}`);
    if (parts.length > 0) return parts.join("\n\n");
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const entry = asRecord(item);
        return typeof entry?.text === "string" ? entry.text : null;
      })
      .filter((text): text is string => text !== null)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  const message = record.message ?? record.error;
  if (typeof message === "string") return message;
  return undefined;
}

function toolContentFromReplay(
  object: Record<string, unknown>,
): ToolContent | null {
  if (object.type === "toolRequest") {
    const id = typeof object.id === "string" ? object.id : generatedId();
    const toolCall = asRecord(object.toolCall);
    const value = asRecord(toolCall?.value);
    const meta = asRecord(object._meta);
    const summaryTitle = meta?.["goose.toolSummary.title"];
    const name =
      (typeof summaryTitle === "string" && summaryTitle.trim()) ||
      (typeof value?.name === "string" && value.name.trim()) ||
      "Tool";
    return { type: "tool", tool: { id, name, status: "in_progress" } };
  }
  if (object.type === "toolResponse") {
    const id = typeof object.id === "string" ? object.id : generatedId();
    const toolResult = asRecord(object.toolResult);
    const value = asRecord(toolResult?.value);
    const failed = value?.isError === true || structuredExitCode(value) !== 0;
    return {
      type: "tool",
      tool: {
        id,
        name: "Tool result",
        status: failed ? "failed" : "completed",
        result: failed ? structuredToolText(value) : undefined,
      },
    };
  }
  return null;
}

function structuredExitCode(value: unknown): number | null {
  const record = asRecord(value);
  const structured = asRecord(record?.structuredContent);
  const exitCode = structured?.exit_code;
  return typeof exitCode === "number" ? exitCode : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function imageContent(object: Record<string, unknown>): ImageContent | null {
  if (object.type !== "image") return null;
  const data = object.data;
  const mimeType = object.mimeType;
  if (typeof data !== "string" || typeof mimeType !== "string") return null;
  return { type: "image", data, mimeType };
}
