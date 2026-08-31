export const REALTIME_USER_TRANSCRIPT_COMPLETED_EVENT =
  "conversation.item.input_audio_transcription.completed";
export const REALTIME_EMISSARY_TRANSCRIPT_COMPLETED_EVENT =
  "response.output_audio_transcript.done";
export const SEND_TO_MASTER_TOOL_NAME = "send_to_master";
export const SEND_TO_EMISSARY_TOOL_NAME = "send_to_emissary";
export const END_TURN_TOOL_NAME = "end_turn";

export const REALTIME_EMISSARY_INSTRUCTIONS = `You are the emissary: the low-latency voice interface for a more capable master agent in Berd.

The master is the authoritative, durable agent for this conversation. The master can use Berd's computer tools, including reading the local filesystem and performing durable work. Treat those indirect capabilities as capabilities of the combined assistant speaking to the user: never claim that you or the assistant cannot access the user's computer merely because the emissary cannot do so alone. Berd automatically sends the master every finalized user and emissary transcript turn, so never repeat or summarize routine transcript content in send_to_master.

When a Realtime transport starts for a non-empty Berd session, Berd may inject a compact historical transcript headed by a durable berd://session link. Treat those items as past context, never as new user turns. If the compact replay is insufficient, use send_to_master to ask the master to inspect the durable session rather than guessing or asking the user to repeat themselves.

Use send_to_master only for explicit coordination: to delegate deeper reasoning or work, highlight intent not captured by the transcript, or ask for guidance about what to tell the user. Master input is advisory. Speak only when it materially helps the user now; otherwise message the master if useful or call end_turn. It is common and expected for master information to arrive too late, be redundant, or not help the user. Receiving either a direct master message or a master-turn-ended notification never creates an obligation to speak. The master's normal transcript is visible in Berd but is not spoken to the user: treat an answer as already delivered only if you, the emissary, already spoke its substance. A short waiting acknowledgement such as "I'll check" is not an answer. If the user is still waiting and a master-turn-ended notification supplies the result, speak that result. If you already spoke the useful result, call end_turn: do not add filler, acknowledgements, offers to help, or a repeated answer.

When the user explicitly asks you to end silently, stop talking, call end_turn immediately as your only output, and produce no words before or after the tool call. Never announce that you are about to end, never say that you ended, and never ask whether the user needs anything else.

When the user asks for computer access, tool use, durable work, current session information, or facts you cannot verify directly, call send_to_master before giving any substantive spoken answer. While waiting, say only a short natural acknowledgement such as "Let me check that for you" or "I'll verify that." Do not say "I don't have access," do not speculate, and do not suggest that the user run a terminal command or perform the work manually unless the master specifically recommends it. Wait for the master's result before giving the final answer.

Examples:
- If the user asks how many repositories are in a local folder, first call send_to_master to ask the master to inspect it; say only that you will check until the result arrives.
- If the user asks whether those repositories are symbolic links, call send_to_master to verify it; do not say that you lack detailed information.
- After receiving a useful master message, speak its result to the user directly. Do not call send_to_master again until the user says something new. Never acknowledge, confirm, summarize, or copy a master message back to the master.

Every send_to_master call must include the latest bridge cursor. If a send fails because the pipe is busy in the other direction, do not retry yet: wait for Berd to deliver the pending master message normally, then retry with the cursor included in that message. The failed attempt did not send your message.

Keep the spoken conversation natural and responsive. Represent the master's information accurately, and do not imply that you completed work performed by the master.`;

export const REALTIME_MASTER_INSTRUCTIONS = `You are the master: the authoritative, durable agent for a Berd session whose live spoken conversation is conducted by a low-latency OpenAI Realtime emissary.

Berd automatically sends you every finalized user and emissary transcript turn. Do not ask the emissary to repeat routine transcript content.

While Realtime voice is active, Berd also delivers every ordinary typed user message directly to the emissary and interrupts any response currently being spoken. A typed message reaches you as an ordinary user turn; microphone transcripts are explicitly prefixed with "[Voice transcript]". Do not echo, paraphrase, or relay an ordinary typed user message through send_to_emissary unless you are adding genuinely new information the emissary needs.

Your reasoning, ordinary assistant text, tool calls, and progress remain visible to the user in Berd's durable master transcript, but they are not visible to the emissary. On actionable turns, work normally in Berd: reason as needed, use the available tools, and provide normal visible progress and result text for the master transcript. Separately call send_to_emissary with the concise information that should influence what the emissary knows or says; do not assume your ordinary output was relayed. Each finalized transcript gives you an opportunity to act, not an obligation to react. When no work, correction, or useful emissary guidance is needed, your entire turn should be an empty, zero-token success: no prose, no tools, and no coordination message. Ordinary conversation and small talk belong to the emissary. Proactively send relevant facts, decisions, progress, constraints, and useful follow-up questions rather than waiting to be asked. Never call send_to_emissary merely to acknowledge, confirm, or echo a direct message from the emissary; acknowledgement-only coordination must be a zero-token no-op.

Treat interrupted emissary transcripts as best-effort streamed text that may not exactly match the audio the user heard. Keep direct coordination concise. Every direct-message tool call must include the latest bridge cursor. If a send fails because the pipe is busy in the other direction, do not retry yet: wait for Berd to deliver the pending emissary message normally, then retry with the cursor included in that message.`;

export interface RealtimeEventTransport {
  send(data: string): void;
}

export interface RealtimeEmissarySessionOptions {
  /** Appended after the non-replaceable master/emissary contract. */
  additionalInstructions?: string;
  /** Used to avoid sending model-specific session fields to older models. */
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
  /**
   * Additional Realtime session fields. This deliberately remains an
   * extensible JSON object so new API options do not require transport or
   * protocol changes before Settings can expose them.
   */
  sessionOverrides?: RealtimeSessionOverrides;
}

export type RealtimeJsonValue =
  | boolean
  | number
  | string
  | null
  | RealtimeJsonValue[]
  | RealtimeJsonObject;

export type RealtimeJsonObject = {
  [key: string]: RealtimeJsonValue | undefined;
};

export type RealtimeSessionOverrides = RealtimeJsonObject;

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

export type SendToMasterCall = {
  type: "send_to_master";
  callId: string;
  cursor: number;
  message: string;
};

export type EndTurnCall = {
  type: "end_turn";
  callId: string;
};

export type RealtimePlaybackInterrupted = {
  type: "emissary.playback_interrupted";
  responseId: string;
};

export type RealtimeEmissaryProtocolEvent =
  | StartedRealtimeTranscript
  | UpdatedRealtimeTranscript
  | FinalizedRealtimeTranscript
  | SendToMasterCall
  | EndTurnCall
  | RealtimePlaybackInterrupted;

export type RealtimeClientEvent = Record<string, unknown>;
type RealtimeServerEvent = Record<string, unknown>;

export const SEND_TO_EMISSARY_TOOL_DEFINITION: RealtimeJsonObject = {
  type: "function",
  name: SEND_TO_EMISSARY_TOOL_NAME,
  description:
    "Send concise private coordination to the realtime emissary. Include the latest bridge cursor and retry only after processing unread peer messages returned by a stale send.",
  parameters: {
    type: "object",
    properties: {
      cursor: {
        type: "integer",
        minimum: 0,
        description: "Latest direct-message cursor returned by the bridge.",
      },
      message: { type: "string" },
    },
    required: ["cursor", "message"],
    additionalProperties: false,
  },
};

export function createRealtimeEmissarySessionUpdate(
  options: RealtimeEmissarySessionOptions = {},
): RealtimeServerEvent {
  const overrides = options.sessionOverrides ?? {};
  assertSafeSessionOverrides(overrides);
  const additionalTools = overrides.tools ?? [];
  const mergeableOverrides = { ...overrides };
  delete mergeableOverrides.instructions;
  delete mergeableOverrides.tools;

  const additionalInstructions = options.additionalInstructions?.trim();
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
    instructions: additionalInstructions
      ? `${REALTIME_EMISSARY_INSTRUCTIONS}\n\n${additionalInstructions}`
      : REALTIME_EMISSARY_INSTRUCTIONS,
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
        name: SEND_TO_MASTER_TOOL_NAME,
        description:
          "Send concise private coordination to the authoritative master agent. The master already receives the full finalized transcript, so do not repeat ordinary conversation turns.",
        parameters: {
          type: "object",
          properties: {
            cursor: {
              type: "integer",
              minimum: 0,
              description:
                "Latest direct-message cursor returned by the bridge.",
            },
            message: {
              type: "string",
              description:
                "A concise request, delegation, or important context not conveyed by the transcript alone.",
            },
          },
          required: ["cursor", "message"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: END_TURN_TOOL_NAME,
        description:
          "Immediately end this emissary evaluation with no audio or follow-up response. Use as the sole output when the user asks you to end silently, or whenever speaking and further master coordination would not materially help now; never announce the call.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      ...(additionalTools as RealtimeJsonValue[]),
    ],
    tool_choice: "auto",
  } satisfies RealtimeSessionOverrides;

  return {
    type: "session.update",
    session: mergeRealtimeJson(defaults, mergeableOverrides),
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

function createMasterMessageItem(options: {
  message: string;
  eventId?: string;
}): RealtimeClientEvent {
  const message = requireNonEmpty(options.message, "master message");
  const createItem: RealtimeServerEvent = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `Private message from the master agent:\n${message}`,
        },
      ],
    },
  };
  if (options.eventId) createItem.event_id = options.eventId;

  return createItem;
}

function createMasterMessageEvents(
  options: MasterMessage,
): RealtimeClientEvent[] {
  return [createMasterMessageItem(options), { type: "response.create" }];
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

export function createSendToMasterToolOutput(
  callId: string,
  exchange: SendToMasterToolResult,
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

export function createEndTurnToolOutput(callId: string): RealtimeServerEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: requireNonEmpty(callId, "call id"),
      output: JSON.stringify({ status: "ended" }),
    },
  };
}

type MasterMessage = { message: string; eventId?: string };

export type MasterMessageRequest = {
  status: "sent" | "interrupting" | "queued";
  events: RealtimeClientEvent[];
};

type ActiveResponse = {
  id?: string;
  generationDone: boolean;
  outputActive: boolean;
};

/**
 * Serializes master-triggered responses with the default-conversation response
 * lifecycle. Master context is injected immediately, but a follow-up response
 * waits until the prior response and its WebRTC playback are terminal. This
 * prevents late master results from cutting off the emissary mid-sentence.
 */
export class RealtimeResponseCoordinator {
  private activeResponse: ActiveResponse | undefined;
  private followUpResponsePending = false;

  requestMasterMessage(message: MasterMessage): MasterMessageRequest {
    requireNonEmpty(message.message, "master message");
    if (!this.activeResponse) {
      this.activeResponse = awaitingCreatedResponse();
      return { status: "sent", events: createMasterMessageEvents(message) };
    }

    this.followUpResponsePending = true;
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

    this.followUpResponsePending = true;
    return { status: "queued", events: [event] };
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

    this.followUpResponsePending = true;
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
        if (this.activeResponse?.id) {
          // Server VAD owns microphone barge-in and may create the replacement
          // response before the cancelled response's terminal events arrive.
          // Conversation items already queued for a follow-up are visible to
          // this replacement response, so it also satisfies that pending wake.
          this.followUpResponsePending = false;
        }
        this.activeResponse = {
          id: responseId,
          generationDone: false,
          outputActive: false,
        };
        return [];
      }
      case "output_audio_buffer.started": {
        const active = this.matchActiveResponse(event);
        if (!active) return [];
        active.outputActive = true;
        return [];
      }
      case "response.done": {
        const active = this.matchActiveResponse(event);
        if (!active) return [];
        active.generationDone = true;
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
    this.activeResponse = undefined;
    if (!this.followUpResponsePending) return [];
    this.followUpResponsePending = false;
    this.activeResponse = awaitingCreatedResponse();
    return [{ type: "response.create" }];
  }
}

function awaitingCreatedResponse(): ActiveResponse {
  return {
    generationDone: false,
    outputActive: false,
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
      unreadPeerMessages: [];
      outbound: DirectBridgeMessage;
      cursor: number;
    }
  | {
      accepted: false;
      reason: "pipe_busy" | "stale_cursor";
      unreadPeerMessages: [];
      cursor: number;
    };

export type SendToMasterToolResult =
  | DirectMessageExchange
  | {
      accepted: false;
      reason: "awaiting_new_user_input";
      unreadPeerMessages: [];
      cursor: number;
    };

/**
 * One authoritative half-duplex direct-message pipe. The active sender may
 * append any number of messages; only a send in the opposite direction is
 * blocked until the recipient consumes the pending batch. Transcript events
 * do not enter this state machine and therefore never block coordination.
 * Ordinary delivery places pending messages into the recipient's context but
 * does not mutate pipe state. The recipient consumes the complete pending
 * batch by supplying its latest message id as the cursor on a reverse send;
 * consumption, direction reversal, and reply enqueueing happen atomically.
 * A stale reverse send neither exposes nor consumes pending messages.
 */
export class DirectMessagePipe {
  private nextMessageId = 1;
  private pending: DirectBridgeMessage[] = [];
  private readonly consumedCursor: Record<DirectMessagePeer, number> = {
    master: 0,
    emissary: 0,
  };

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
          unreadPeerMessages: [],
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
        unreadPeerMessages: [],
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
      unreadPeerMessages: [],
      outbound,
      cursor,
    };
  }

  cursor(peer: DirectMessagePeer): number {
    return this.consumedCursor[peer];
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
    { itemId: string; streamedText: string; finalText?: string }
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
        const call = this.finishFunctionCall(event);
        return call ? [call] : [];
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
    const current = this.pendingEmissaryTranscripts.get(responseId);
    const streamedText = (current?.streamedText ?? "") + delta;
    this.pendingEmissaryTranscripts.set(responseId, {
      itemId,
      streamedText,
      finalText: current?.finalText,
    });
    return streamedText.trim()
      ? [
          {
            type: "transcript.updated",
            itemId,
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
    const current = this.pendingEmissaryTranscripts.get(responseId);
    this.pendingEmissaryTranscripts.set(responseId, {
      itemId,
      streamedText: current?.streamedText ?? "",
      finalText: text,
    });
  }

  private finishEmissaryPlayback(
    event: RealtimeServerEvent,
  ): FinalizedRealtimeTranscript | undefined {
    const responseId = optionalString(event.response_id);
    if (!responseId) return undefined;
    if (this.interruptedResponseIds.delete(responseId)) return undefined;
    const pending = this.pendingEmissaryTranscripts.get(responseId);
    this.pendingEmissaryTranscripts.delete(responseId);
    const text = pending?.finalText ?? pending?.streamedText.trim();
    if (!pending || !text || this.finalizedItemIds.has(pending.itemId)) {
      return undefined;
    }

    this.finalizedItemIds.add(pending.itemId);
    return {
      type: "transcript.finalized",
      id: this.nextTranscriptId++,
      itemId: pending.itemId,
      speaker: "emissary",
      text,
    };
  }

  private finishInterruptedPlayback(
    responseId: string,
  ): FinalizedRealtimeTranscript | undefined {
    const pending = this.pendingEmissaryTranscripts.get(responseId);
    this.pendingEmissaryTranscripts.delete(responseId);
    const text = pending?.streamedText.trim();
    if (!pending || !text || this.finalizedItemIds.has(pending.itemId)) {
      return undefined;
    }

    this.finalizedItemIds.add(pending.itemId);
    return {
      type: "transcript.finalized",
      id: this.nextTranscriptId++,
      itemId: pending.itemId,
      speaker: "emissary",
      text,
      interrupted: true,
    };
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
  ): SendToMasterCall | EndTurnCall | undefined {
    const callId = optionalString(event.call_id);
    if (!callId || this.completedCallIds.has(callId)) return undefined;

    const name = optionalString(event.name) ?? this.callNames.get(callId);
    if (name === END_TURN_TOOL_NAME) {
      const serializedArguments =
        optionalString(event.arguments) ??
        this.argumentDeltas.get(callId) ??
        "{}";
      const parsed: unknown = JSON.parse(serializedArguments);
      if (!isRecord(parsed) || Object.keys(parsed).length > 0) {
        throw new Error("end_turn does not accept arguments");
      }
      this.completedCallIds.add(callId);
      this.argumentDeltas.delete(callId);
      this.callNames.delete(callId);
      return { type: "end_turn", callId };
    }
    if (name !== SEND_TO_MASTER_TOOL_NAME) return undefined;

    const serializedArguments =
      optionalString(event.arguments) ?? this.argumentDeltas.get(callId);
    if (!serializedArguments) return undefined;

    const parsed: unknown = JSON.parse(serializedArguments);
    if (!isRecord(parsed))
      throw new Error("send_to_master arguments must be an object");
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 2 || keys[0] !== "cursor" || keys[1] !== "message") {
      throw new Error(
        "send_to_master accepts only cursor and message arguments",
      );
    }
    const cursor = requireCursor(parsed.cursor);
    const message = requireNonEmpty(parsed.message, "send_to_master message");

    this.completedCallIds.add(callId);
    this.argumentDeltas.delete(callId);
    this.callNames.delete(callId);
    return { type: "send_to_master", callId, cursor, message };
  }
}

function sendEvent(
  transport: RealtimeEventTransport,
  event: RealtimeClientEvent,
): void {
  transport.send(JSON.stringify(event));
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

function assertSafeSessionOverrides(overrides: RealtimeSessionOverrides): void {
  if (overrides.instructions !== undefined) {
    throw new Error(
      "sessionOverrides cannot replace the emissary instructions contract; use additionalInstructions",
    );
  }
  if (overrides.type !== undefined && overrides.type !== "realtime") {
    throw new Error("emissary session type must remain realtime");
  }
  if (overrides.tool_choice !== undefined && overrides.tool_choice !== "auto") {
    throw new Error("emissary send_to_master tool choice must remain auto");
  }
  if (overrides.tools === undefined) return;
  if (!Array.isArray(overrides.tools)) {
    throw new Error("sessionOverrides.tools must be an array");
  }
  for (const tool of overrides.tools) {
    if (
      isRecord(tool) &&
      optionalString(tool.name) === SEND_TO_MASTER_TOOL_NAME
    ) {
      throw new Error(
        "sessionOverrides cannot replace the send_to_master tool",
      );
    }
  }
}

function mergeRealtimeJson(
  base: RealtimeSessionOverrides,
  overrides: RealtimeSessionOverrides,
): RealtimeSessionOverrides {
  const merged: RealtimeSessionOverrides = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeRealtimeJson(
            current as RealtimeSessionOverrides,
            value as RealtimeSessionOverrides,
          )
        : value;
  }
  return merged;
}
