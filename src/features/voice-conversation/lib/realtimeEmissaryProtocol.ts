import promptDocument from "../prompts/expert-spokesperson.md?raw";

export const REALTIME_USER_TRANSCRIPT_COMPLETED_EVENT =
  "conversation.item.input_audio_transcription.completed";
export const REALTIME_EMISSARY_TRANSCRIPT_COMPLETED_EVENT =
  "response.output_audio_transcript.done";
export const HANDOFF_TOOL_NAME = "handoff";
export const SEND_TO_SPOKESPERSON_TOOL_NAME = "send_to_spokesperson";

export const REALTIME_PROMPT_DOCUMENT = promptDocument.trim();
const REALTIME_ROLE_PLACEHOLDER = "{{ROLE}}";

function createRealtimeRoleInstructions(
  role: "Expert" | "Spokesperson",
): string {
  const normalized = REALTIME_PROMPT_DOCUMENT.replaceAll("\r\n", "\n").trim();
  const placeholderCount =
    normalized.split(REALTIME_ROLE_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `Realtime prompt must contain exactly one ${REALTIME_ROLE_PLACEHOLDER} placeholder.`,
    );
  }
  return normalized.replace(REALTIME_ROLE_PLACEHOLDER, role);
}

export const REALTIME_SPOKESPERSON_INSTRUCTIONS =
  createRealtimeRoleInstructions("Spokesperson");
export const REALTIME_EXPERT_INSTRUCTIONS =
  createRealtimeRoleInstructions("Expert");

export interface RealtimeEventTransport {
  send(data: string): void;
}

export interface RealtimeEmissarySessionOptions {
  /** Reasoning configuration is emitted only for model families that support it. */
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

export type FinalizedRealtimeTranscript = {
  type: "transcript.finalized";
  id: number;
  itemId: string;
  speaker: "user" | "emissary";
  text: string;
  /** Best-effort streamed text; it may not exactly match the audio heard. */
  interrupted?: true;
};

export type UpdatedRealtimeTranscript = {
  type: "transcript.updated";
  itemId: string;
  speaker: "user" | "emissary";
  text: string;
};

export type StartedRealtimeTranscript = {
  type: "transcript.started";
  itemId: string;
  speaker: "user";
};

export type HandoffCall = {
  type: "handoff";
  callId: string;
  message: string;
};

export type InvalidToolCall = {
  type: "tool_call.invalid";
  callId: string;
  toolName: typeof HANDOFF_TOOL_NAME;
  error: string;
};

export type RealtimePlaybackInterrupted = {
  type: "emissary.playback_interrupted";
  responseId: string;
};

export type RealtimeEmissaryProtocolEvent =
  | StartedRealtimeTranscript
  | UpdatedRealtimeTranscript
  | FinalizedRealtimeTranscript
  | HandoffCall
  | InvalidToolCall
  | RealtimePlaybackInterrupted;

export type RealtimeClientEvent = Record<string, unknown>;
type RealtimeServerEvent = Record<string, unknown>;

type PendingEmissaryTranscriptItem = {
  streamedText: string;
  finalText?: string;
};

type PendingEmissaryTranscript = {
  displayItemId: string;
  items: Map<string, PendingEmissaryTranscriptItem>;
};

export function createRealtimeEmissarySessionUpdate(
  options: RealtimeEmissarySessionOptions = {},
): RealtimeServerEvent {
  const transcriptionLanguage = options.transcriptionLanguage?.trim();
  const transcriptionPrompt = options.transcriptionPrompt?.trim();
  const supportsReasoning =
    !options.model || options.model.startsWith("gpt-realtime-2.1");
  const turnDetection =
    options.turnDetection === "semantic_vad"
      ? {
          type: "semantic_vad",
          eagerness: options.eagerness ?? "auto",
          create_response: options.createResponse ?? true,
          interrupt_response: options.interruptResponse ?? true,
        }
      : {
          type: "server_vad",
          threshold: options.vadThreshold ?? 0.5,
          prefix_padding_ms: options.prefixPaddingMs ?? 300,
          silence_duration_ms: options.silenceDurationMs ?? 500,
          ...(options.idleTimeoutMs
            ? { idle_timeout_ms: options.idleTimeoutMs }
            : {}),
          create_response: options.createResponse ?? true,
          interrupt_response: options.interruptResponse ?? true,
        };
  const defaults = {
    type: "realtime",
    output_modalities: ["audio"],
    ...(supportsReasoning &&
    options.reasoningEffort &&
    options.reasoningEffort !== "default"
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
    max_output_tokens: options.maxOutputTokens ?? "inf",
    instructions: REALTIME_SPOKESPERSON_INSTRUCTIONS,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: {
          model: options.transcriptionModel ?? "gpt-realtime-whisper",
          ...(transcriptionLanguage ? { language: transcriptionLanguage } : {}),
          ...(transcriptionPrompt ? { prompt: transcriptionPrompt } : {}),
        },
        noise_reduction:
          options.noiseReduction && options.noiseReduction !== "off"
            ? { type: options.noiseReduction }
            : null,
        turn_detection: turnDetection,
      },
      output: {
        format: { type: "audio/pcm", rate: 24_000 },
        voice: options.voice ?? "marin",
        speed: options.speed ?? 1,
      },
    },
    tools: [
      {
        type: "function",
        name: HANDOFF_TOOL_NAME,
        description:
          "Hand unresolved work or an authoritative question to the Expert. Every accepted handoff must eventually be answered or explicitly dismissed.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description:
                "The concise unresolved request the Expert now owns.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "auto",
  };

  return {
    type: "session.update",
    session: defaults,
  };
}

export function configureRealtimeEmissarySession(
  transport: RealtimeEventTransport,
  options: RealtimeEmissarySessionOptions = {},
): void {
  sendRealtimeEvents(transport, [createRealtimeEmissarySessionUpdate(options)]);
}

export function sendRealtimeEvents(
  transport: RealtimeEventTransport,
  events: readonly RealtimeClientEvent[],
): void {
  for (const event of events) sendEvent(transport, event);
}

export type MasterMessageMode = "context" | "say";

function createMasterMessageItem(options: MasterMessage): RealtimeClientEvent {
  const message = requireNonEmpty(options.message, "master message");
  const text =
    options.mode === "say"
      ? `The Expert has decided the following information must be spoken to the user now. Speak it naturally and accurately without adding filler or offering more help:\n${message}`
      : `Private context from the Expert for a future natural turn. Do not respond to this item now:\n${message}`;
  const createItem: RealtimeServerEvent = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text,
        },
      ],
    },
  };
  if (options.eventId) createItem.event_id = options.eventId;

  return createItem;
}

function createMasterSayResponseEvent(message: string): RealtimeClientEvent {
  return {
    type: "response.create",
    response: {
      instructions: `Speak this Expert message to the user now, preserving its meaning: ${requireNonEmpty(message, "master message")} Be natural, concise, and accurate. Do not call tools.`,
      tools: [],
      tool_choice: "none",
    },
  };
}

function createTypedUserMessageItem(text: string): RealtimeClientEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: requireNonEmpty(text, "user text") },
      ],
    },
  };
}

export function createHandoffToolOutput(
  callId: string,
  exchange: HandoffToolResult,
): RealtimeServerEvent {
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
): RealtimeServerEvent {
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

type MasterMessage = {
  message: string;
  mode: MasterMessageMode;
  eventId?: string;
  resolvedHandoffIds?: string[];
};

export type MasterMessageRequest = {
  status: "sent" | "interrupting" | "queued";
  events: RealtimeClientEvent[];
};

type ActiveResponse = {
  id?: string;
  generationDone: boolean;
  outputActive: boolean;
  outputProduced: boolean;
  succeeded: boolean;
  say?: MasterMessage;
};

type PendingResponse =
  | { mode: "default" }
  | { mode: "say"; message: MasterMessage };

/**
 * Serializes master-triggered responses with the default-conversation response
 * lifecycle. Master context is injected immediately, but a follow-up response
 * waits until the prior response and its WebRTC playback are terminal. This
 * prevents late master results from cutting off the emissary mid-sentence.
 */
export class RealtimeResponseCoordinator {
  private activeResponse: ActiveResponse | undefined;
  private pendingResponses: PendingResponse[] = [];
  private completedHandoffIds: string[] = [];
  private failedHandoffIds: string[] = [];

  requestMasterMessage(message: MasterMessage): MasterMessageRequest {
    requireNonEmpty(message.message, "master message");
    if (message.mode === "context") {
      return { status: "sent", events: [createMasterMessageItem(message)] };
    }
    if (!this.activeResponse) {
      this.activeResponse = awaitingCreatedResponse(message);
      return {
        status: "sent",
        events: [
          createMasterMessageItem(message),
          createMasterSayResponseEvent(message.message),
        ],
      };
    }

    this.pendingResponses.push({ mode: "say", message });
    return {
      status: "queued",
      events: [createMasterMessageItem(message)],
    };
  }

  requestToolOutput(event: RealtimeClientEvent): MasterMessageRequest {
    if (!this.activeResponse) {
      this.activeResponse = awaitingCreatedResponse();
      return {
        status: "sent",
        events: [event, { type: "response.create" }],
      };
    }

    this.queueDefaultResponse();
    return { status: "queued", events: [event] };
  }

  recordToolOutput(event: RealtimeClientEvent): MasterMessageRequest {
    return { status: "sent", events: [event] };
  }

  requestTypedUserMessage(text: string): MasterMessageRequest {
    const item = createTypedUserMessageItem(text);
    if (!this.activeResponse) {
      this.activeResponse = awaitingCreatedResponse();
      return {
        status: "sent",
        events: [
          { type: "input_audio_buffer.clear" },
          item,
          { type: "response.create" },
        ],
      };
    }

    this.queueDefaultResponse();
    const events: RealtimeClientEvent[] = [];
    if (this.activeResponse.id && !this.activeResponse.generationDone) {
      events.push({
        type: "response.cancel",
        response_id: this.activeResponse.id,
      });
    }
    if (this.activeResponse.outputActive) {
      events.push({ type: "output_audio_buffer.clear" });
    }
    events.push({ type: "input_audio_buffer.clear" }, item);
    return {
      status: this.activeResponse.id ? "interrupting" : "queued",
      events,
    };
  }

  handle(event: unknown): RealtimeClientEvent[] {
    if (!isRecord(event)) return [];
    switch (event.type) {
      case "response.created": {
        const responseId = nestedResponseId(event);
        if (!responseId)
          throw new Error("response.created is missing response.id");
        const requestedSay = this.activeResponse?.id
          ? undefined
          : this.activeResponse?.say;
        if (this.activeResponse?.id) {
          if (this.activeResponse.say) {
            this.failedHandoffIds.push(
              ...(this.activeResponse.say.resolvedHandoffIds ?? []),
            );
          }
          // Server VAD owns microphone barge-in and may create the replacement
          // response before the cancelled response's terminal events arrive.
          // Conversation items already queued for a follow-up are visible to
          // this replacement response, so it also satisfies that pending wake.
          this.pendingResponses = this.pendingResponses.filter(
            (pending) => pending.mode === "say",
          );
        }
        this.activeResponse = {
          id: responseId,
          generationDone: false,
          outputActive: false,
          outputProduced: false,
          succeeded: false,
          say: requestedSay,
        };
        return [];
      }
      case "output_audio_buffer.started": {
        const active = this.matchActiveResponse(event);
        if (!active) return [];
        active.outputActive = true;
        active.outputProduced = true;
        return [];
      }
      case "response.done": {
        const active = this.matchActiveResponse(event);
        if (!active) return [];
        active.generationDone = true;
        active.succeeded = nestedResponseStatus(event) === "completed";
        if (!active.outputActive) return this.finishActiveResponse();
        return [];
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        const active = this.matchActiveResponse(event);
        if (!active) return [];
        active.outputActive = false;
        return active.generationDone ? this.finishActiveResponse() : [];
      }
      default:
        return [];
    }
  }

  private matchActiveResponse(
    event: RealtimeServerEvent,
  ): ActiveResponse | undefined {
    const active = this.activeResponse;
    if (!active) return undefined;
    const responseId =
      optionalString(event.response_id) ?? nestedResponseId(event);
    return !responseId || !active.id || responseId === active.id
      ? active
      : undefined;
  }

  private finishActiveResponse(): RealtimeClientEvent[] {
    const completed = this.activeResponse;
    this.activeResponse = undefined;
    if (completed?.say) {
      const target =
        completed.succeeded && completed.outputProduced
          ? this.completedHandoffIds
          : this.failedHandoffIds;
      target.push(...(completed.say.resolvedHandoffIds ?? []));
    }
    const pending = this.pendingResponses.shift();
    if (!pending) return [];
    this.activeResponse = awaitingCreatedResponse(
      pending.mode === "say" ? pending.message : undefined,
    );
    return [
      pending.mode === "say"
        ? createMasterSayResponseEvent(pending.message.message)
        : { type: "response.create" },
    ];
  }

  takeCompletedHandoffIds(): string[] {
    return this.completedHandoffIds.splice(0);
  }

  takeFailedHandoffIds(): string[] {
    return this.failedHandoffIds.splice(0);
  }

  private queueDefaultResponse(): void {
    if (!this.pendingResponses.some((pending) => pending.mode === "default")) {
      this.pendingResponses.push({ mode: "default" });
    }
  }
}

function awaitingCreatedResponse(say?: MasterMessage): ActiveResponse {
  return {
    generationDone: false,
    outputActive: false,
    outputProduced: false,
    succeeded: false,
    say,
  };
}

function nestedResponseStatus(event: RealtimeServerEvent): string | undefined {
  return isRecord(event.response)
    ? optionalString(event.response.status)
    : undefined;
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

export type HandoffToolResult = {
  accepted: true;
  handoff_id: string;
};

/**
 * One authoritative half-duplex pipe for every event crossing between the
 * realtime conversation and the master. The active sender may append any
 * number of messages; only a send in the opposite direction is blocked until
 * the recipient consumes the pending batch. The recipient consumes the
 * complete pending batch by supplying its latest message id as the cursor on
 * a reverse send; consumption, direction reversal, and reply enqueueing
 * happen atomically. A stale reverse send neither exposes nor consumes
 * pending messages.
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
      recipient: otherPeer(options.sender),
      senderCursor: cursor,
      message,
    };
    this.pending.push(outbound);
    return {
      accepted: true,
      outbound,
      cursor,
    };
  }

  cursor(peer: DirectMessagePeer): number {
    return this.consumedCursor[peer];
  }

  /**
   * Cursor available at a trusted delivery boundary. If the peer has pending
   * inbound messages, transport delivery proves it has received the complete
   * batch; otherwise its last explicitly consumed cursor remains current.
   * Model-authored tool calls must continue to supply their own cursor.
   */
  deliveryCursor(peer: DirectMessagePeer): number {
    const latestPending = this.pending.at(-1);
    return latestPending?.recipient === peer
      ? latestPending.id
      : this.consumedCursor[peer];
  }
}

function otherPeer(peer: DirectMessagePeer): DirectMessagePeer {
  return peer === "master" ? "emissary" : "master";
}

/**
 * Reduces Realtime server events to the durable bridge events Berd needs.
 * One instance belongs to one Realtime session; it supplies local ordering and
 * suppresses repeated terminal events by their stable OpenAI item/call ids.
 */
export class RealtimeEmissaryProtocol {
  private nextTranscriptId = 1;
  private readonly finalizedItemIds = new Set<string>();
  private readonly completedCallIds = new Set<string>();
  private readonly callNames = new Map<string, string>();
  private readonly argumentDeltas = new Map<string, string>();
  private readonly pendingUserTranscripts = new Map<string, string>();
  private readonly pendingEmissaryTranscripts = new Map<
    string,
    PendingEmissaryTranscript
  >();
  private readonly interruptedResponseIds = new Set<string>();

  handle(event: unknown): RealtimeEmissaryProtocolEvent[] {
    if (!isRecord(event)) return [];

    switch (event.type) {
      case "error":
      case "conversation.item.input_audio_transcription.failed":
        throw new Error(realtimeErrorMessage(event));
      case "response.output_item.added":
        this.captureFunctionCallName(event);
        return [];
      case "response.function_call_arguments.delta":
        this.captureFunctionArguments(event);
        return [];
      case "response.function_call_arguments.done": {
        try {
          const call = this.finishFunctionCall(event);
          return call ? [call] : [];
        } catch (error) {
          const invalidCall = this.invalidFunctionCall(event, error);
          if (!invalidCall) throw error;
          return [invalidCall];
        }
      }
      case "input_audio_buffer.speech_started": {
        const itemId = optionalString(event.item_id);
        return itemId && !this.finalizedItemIds.has(itemId)
          ? [{ type: "transcript.started", itemId, speaker: "user" }]
          : [];
      }
      case REALTIME_USER_TRANSCRIPT_COMPLETED_EVENT: {
        const transcript = this.finalizedTranscript(event, "user");
        return transcript ? [transcript] : [];
      }
      case "conversation.item.input_audio_transcription.delta": {
        const transcript = this.captureUserTranscriptDelta(event);
        return transcript ? [transcript] : [];
      }
      case REALTIME_EMISSARY_TRANSCRIPT_COMPLETED_EVENT: {
        this.captureEmissaryTranscript(event);
        return [];
      }
      case "response.output_audio_transcript.delta":
        return this.captureEmissaryTranscriptDelta(event);
      case "output_audio_buffer.stopped": {
        const transcript = this.finishEmissaryPlayback(event);
        return transcript ? [transcript] : [];
      }
      case "output_audio_buffer.cleared": {
        const responseId = optionalString(event.response_id);
        if (!responseId) return [];
        this.interruptedResponseIds.add(responseId);
        const transcript = this.finishInterruptedPlayback(responseId);
        return [
          ...(transcript ? [transcript] : []),
          { type: "emissary.playback_interrupted", responseId },
        ];
      }
      default:
        return [];
    }
  }

  private captureUserTranscriptDelta(
    event: RealtimeServerEvent,
  ): UpdatedRealtimeTranscript | undefined {
    const itemId = optionalString(event.item_id);
    const delta = optionalString(event.delta);
    if (!itemId || delta === undefined || this.finalizedItemIds.has(itemId))
      return undefined;
    const text = `${this.pendingUserTranscripts.get(itemId) ?? ""}${delta}`;
    this.pendingUserTranscripts.set(itemId, text);
    if (!text.trim()) return undefined;
    return { type: "transcript.updated", itemId, speaker: "user", text };
  }

  private captureEmissaryTranscriptDelta(
    event: RealtimeServerEvent,
  ): UpdatedRealtimeTranscript[] {
    const responseId = optionalString(event.response_id);
    const itemId = optionalString(event.item_id);
    const delta = optionalString(event.delta);
    if (
      !responseId ||
      !itemId ||
      delta === undefined ||
      this.interruptedResponseIds.has(responseId)
    ) {
      return [];
    }
    const pending = this.pendingEmissaryTranscript(responseId, itemId);
    const item = pending.items.get(itemId) ?? { streamedText: "" };
    item.streamedText += delta;
    pending.items.set(itemId, item);
    const streamedText = combinedEmissaryTranscript(pending, false);
    return streamedText.trim()
      ? [
          {
            type: "transcript.updated",
            itemId: pending.displayItemId,
            speaker: "emissary",
            text: streamedText,
          },
        ]
      : [];
  }

  private captureEmissaryTranscript(event: RealtimeServerEvent): void {
    const responseId = optionalString(event.response_id);
    const itemId = optionalString(event.item_id);
    const text = optionalString(event.transcript)?.trim();
    if (
      !responseId ||
      !itemId ||
      !text ||
      this.finalizedItemIds.has(itemId) ||
      this.interruptedResponseIds.has(responseId)
    ) {
      return;
    }
    const pending = this.pendingEmissaryTranscript(responseId, itemId);
    const item = pending.items.get(itemId) ?? { streamedText: "" };
    item.finalText = text;
    pending.items.set(itemId, item);
  }

  private finishEmissaryPlayback(
    event: RealtimeServerEvent,
  ): FinalizedRealtimeTranscript | undefined {
    const responseId = optionalString(event.response_id);
    if (!responseId) return undefined;
    if (this.interruptedResponseIds.delete(responseId)) return undefined;
    const pending = this.pendingEmissaryTranscripts.get(responseId);
    this.pendingEmissaryTranscripts.delete(responseId);
    const text = pending
      ? combinedEmissaryTranscript(pending, true).trim()
      : "";
    if (!pending || !text || this.finalizedItemIds.has(pending.displayItemId)) {
      return undefined;
    }

    for (const itemId of pending.items.keys()) {
      this.finalizedItemIds.add(itemId);
    }
    return {
      type: "transcript.finalized",
      id: this.nextTranscriptId++,
      itemId: pending.displayItemId,
      speaker: "emissary",
      text,
    };
  }

  private finishInterruptedPlayback(
    responseId: string,
  ): FinalizedRealtimeTranscript | undefined {
    const pending = this.pendingEmissaryTranscripts.get(responseId);
    this.pendingEmissaryTranscripts.delete(responseId);
    const text = pending
      ? combinedEmissaryTranscript(pending, false).trim()
      : "";
    if (!pending || !text || this.finalizedItemIds.has(pending.displayItemId)) {
      return undefined;
    }

    for (const itemId of pending.items.keys()) {
      this.finalizedItemIds.add(itemId);
    }
    return {
      type: "transcript.finalized",
      id: this.nextTranscriptId++,
      itemId: pending.displayItemId,
      speaker: "emissary",
      text,
      interrupted: true,
    };
  }

  private pendingEmissaryTranscript(
    responseId: string,
    itemId: string,
  ): PendingEmissaryTranscript {
    const existing = this.pendingEmissaryTranscripts.get(responseId);
    if (existing) return existing;
    const pending = {
      displayItemId: itemId,
      items: new Map<string, PendingEmissaryTranscriptItem>(),
    };
    this.pendingEmissaryTranscripts.set(responseId, pending);
    return pending;
  }

  private finalizedTranscript(
    event: RealtimeServerEvent,
    speaker: "user" | "emissary",
  ): FinalizedRealtimeTranscript | undefined {
    const itemId = optionalString(event.item_id);
    const text = optionalString(event.transcript)?.trim();
    if (!itemId || !text || this.finalizedItemIds.has(itemId)) return undefined;

    this.pendingUserTranscripts.delete(itemId);
    this.finalizedItemIds.add(itemId);
    return {
      type: "transcript.finalized",
      id: this.nextTranscriptId++,
      itemId,
      speaker,
      text,
    };
  }

  private captureFunctionCallName(event: RealtimeServerEvent): void {
    const item = isRecord(event.item) ? event.item : undefined;
    if (item?.type !== "function_call") return;
    const callId = optionalString(item.call_id);
    const name = optionalString(item.name);
    if (callId && name) this.callNames.set(callId, name);
  }

  private captureFunctionArguments(event: RealtimeServerEvent): void {
    const callId = optionalString(event.call_id);
    const delta = optionalString(event.delta);
    if (!callId || delta === undefined) return;
    this.argumentDeltas.set(
      callId,
      (this.argumentDeltas.get(callId) ?? "") + delta,
    );
  }

  private finishFunctionCall(
    event: RealtimeServerEvent,
  ): HandoffCall | undefined {
    const callId = optionalString(event.call_id);
    if (!callId || this.completedCallIds.has(callId)) return undefined;

    const name = optionalString(event.name) ?? this.callNames.get(callId);
    if (name !== HANDOFF_TOOL_NAME) return undefined;

    const serializedArguments =
      optionalString(event.arguments) ?? this.argumentDeltas.get(callId);
    if (!serializedArguments) return undefined;

    const parsed: unknown = JSON.parse(serializedArguments);
    if (!isRecord(parsed))
      throw new Error("handoff arguments must be an object");
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 1 || keys[0] !== "message") {
      throw new Error("handoff accepts only a message argument");
    }
    const message = requireNonEmpty(parsed.message, "handoff message");

    this.completedCallIds.add(callId);
    this.argumentDeltas.delete(callId);
    this.callNames.delete(callId);
    return { type: "handoff", callId, message };
  }

  private invalidFunctionCall(
    event: RealtimeServerEvent,
    error: unknown,
  ): InvalidToolCall | undefined {
    const callId = optionalString(event.call_id);
    if (!callId || this.completedCallIds.has(callId)) return undefined;
    const name = optionalString(event.name) ?? this.callNames.get(callId);
    if (name !== HANDOFF_TOOL_NAME) return undefined;

    this.completedCallIds.add(callId);
    this.argumentDeltas.delete(callId);
    this.callNames.delete(callId);
    return {
      type: "tool_call.invalid",
      callId,
      toolName: name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendEvent(
  transport: RealtimeEventTransport,
  event: RealtimeClientEvent,
): void {
  transport.send(JSON.stringify(event));
}

function combinedEmissaryTranscript(
  pending: PendingEmissaryTranscript,
  preferFinalText: boolean,
): string {
  return [...pending.items.values()]
    .map((item) =>
      preferFinalText && item.finalText !== undefined
        ? item.finalText
        : item.streamedText,
    )
    .map((text) => text.trim())
    .filter(Boolean)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nestedResponseId(event: RealtimeServerEvent): string | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  return optionalString(response?.id);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} cannot be empty`);
  }
  return value.trim();
}

function requireCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("direct-message cursor must be a non-negative integer");
  }
  return value;
}

function realtimeErrorMessage(event: RealtimeServerEvent): string {
  const error = isRecord(event.error) ? event.error : undefined;
  return (
    optionalString(error?.message) ??
    optionalString(event.message) ??
    "OpenAI Realtime reported an unknown error"
  );
}
