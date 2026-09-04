import promptDocument from "../../../../src-tauri/crates/berd-voice/prompts/expert-spokesperson.md?raw";
import { createOpenAiRealtimeSpokespersonSessionUpdate } from "@/shared/api/openaiRealtime";

export const REALTIME_PROMPT_DOCUMENT = promptDocument
  .replaceAll("\r\n", "\n")
  .trim();
const REALTIME_ROLE_PLACEHOLDER = "{{ROLE}}";

function createRealtimeRoleInstructions(
  role: "Expert" | "Spokesperson",
): string {
  const placeholderCount =
    REALTIME_PROMPT_DOCUMENT.split(REALTIME_ROLE_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `Realtime prompt must contain exactly one ${REALTIME_ROLE_PLACEHOLDER} placeholder.`,
    );
  }
  return REALTIME_PROMPT_DOCUMENT.replace(REALTIME_ROLE_PLACEHOLDER, role);
}

export const REALTIME_SPOKESPERSON_INSTRUCTIONS =
  createRealtimeRoleInstructions("Spokesperson");
export const REALTIME_EXPERT_INSTRUCTIONS =
  createRealtimeRoleInstructions("Expert");

export interface RealtimeEventTransport {
  send(data: string): void;
}

export interface RealtimeEmissarySessionOptions {
  model?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
  transcriptionPrompt?: string;
  voice?: string;
  speed?: number;
  turnDetection?: "server_vad" | "semantic_vad";
  eagerness?: "low" | "medium" | "high" | "auto";
  interruptResponse?: boolean;
  createResponse?: boolean;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  idleTimeoutMs?: number | null;
  noiseReduction?: "off" | "near_field" | "far_field";
  reasoningEffort?: "default" | "none" | "low" | "medium" | "high";
  maxOutputTokens?: number | null;
}

export async function configureRealtimeEmissarySession(
  transport: RealtimeEventTransport,
  options: RealtimeEmissarySessionOptions = {},
): Promise<void> {
  const update = await createOpenAiRealtimeSpokespersonSessionUpdate(options);
  sendRealtimeEvents(transport, [update]);
}

export function sendRealtimeEvents(
  transport: RealtimeEventTransport,
  events: readonly Record<string, unknown>[],
): void {
  for (const event of events) transport.send(JSON.stringify(event));
}

export type MasterMessageMode = "context" | "say";

export type HandoffToolResult = {
  accepted: true;
  handoff_id: string;
};

export function createHandoffToolOutput(
  callId: string,
  exchange: HandoffToolResult,
): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: requireNonEmpty(callId, "call id"),
      output: JSON.stringify(exchange),
    },
  };
}

export function createInvalidToolCallOutput(
  callId: string,
  toolName: string,
  error: string,
): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: requireNonEmpty(callId, "call id"),
      output: JSON.stringify({
        accepted: false,
        reason: "invalid_arguments",
        error: `${requireNonEmpty(toolName, "tool name")} arguments were invalid: ${requireNonEmpty(error, "tool error")}. Retry this tool call with complete valid JSON. Do not speak this internal error to the user.`,
      }),
    },
  };
}

export type DirectMessagePeer = "master" | "emissary";

export type DirectBridgeMessage = {
  id: number;
  sender: DirectMessagePeer;
  recipient: DirectMessagePeer;
  senderCursor: number;
  message: string;
};

export type DirectMessageExchange =
  | {
      accepted: true;
      outbound: DirectBridgeMessage;
      cursor: number;
    }
  | {
      accepted: false;
      reason: "pipe_busy" | "stale_cursor";
      cursor: number;
    };

/**
 * The remaining native-only adapter boundary. Causal pipe ownership moves into
 * berd-voice in the next slice; keeping it isolated here makes that deletion
 * mechanical while the shared Realtime reducer is already authoritative.
 */
export class DirectMessagePipe {
  private nextMessageId: number;
  private pending: DirectBridgeMessage[] = [];
  private readonly consumedCursor: Record<DirectMessagePeer, number>;

  constructor(initialCursor = 0) {
    this.nextMessageId = initialCursor + 1;
    this.consumedCursor = {
      master: initialCursor,
      emissary: initialCursor,
    };
  }

  send(options: {
    sender: DirectMessagePeer;
    cursor: number;
    message: string;
  }): DirectMessageExchange {
    const message = requireNonEmpty(options.message, "direct message");
    const suppliedCursor = requireCursor(options.cursor);
    const activeMessage = this.pending[0];
    if (activeMessage && activeMessage.sender !== options.sender) {
      const latestPending = this.pending.at(-1);
      if (!latestPending)
        throw new Error("direct-message pending batch cannot be empty");
      if (suppliedCursor !== latestPending.id) {
        return {
          accepted: false,
          reason: "pipe_busy",
          cursor: this.consumedCursor[options.sender],
        };
      }
      this.consumedCursor[options.sender] = latestPending.id;
      this.pending = [];
    }
    const cursor = this.consumedCursor[options.sender];
    if (suppliedCursor !== cursor) {
      return {
        accepted: false,
        reason: "stale_cursor",
        cursor,
      };
    }

    const outbound: DirectBridgeMessage = {
      id: this.nextMessageId++,
      sender: options.sender,
      recipient: options.sender === "master" ? "emissary" : "master",
      senderCursor: cursor,
      message,
    };
    this.pending.push(outbound);
    return { accepted: true, outbound, cursor };
  }

  cursor(peer: DirectMessagePeer): number {
    return this.consumedCursor[peer];
  }

  deliveryCursor(peer: DirectMessagePeer): number {
    const latestPending = this.pending.at(-1);
    return latestPending?.recipient === peer
      ? latestPending.id
      : this.consumedCursor[peer];
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} cannot be empty`);
  }
  return value.trim();
}

function requireCursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("cursor must be a non-negative safe integer");
  }
  return Number(value);
}
