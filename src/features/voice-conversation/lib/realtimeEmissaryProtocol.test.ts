import { describe, expect, it, vi } from "vitest";
import {
  DirectMessagePipe,
  REALTIME_EXPERT_INSTRUCTIONS,
  REALTIME_SPOKESPERSON_INSTRUCTIONS,
  REALTIME_PROMPT_DOCUMENT,
  RealtimeEmissaryProtocol,
  RealtimeResponseCoordinator,
  configureRealtimeEmissarySession,
  createInvalidToolCallOutput,
  createRealtimeEmissarySessionUpdate,
  createHandoffToolOutput,
  sendRealtimeEvents,
} from "./realtimeEmissaryProtocol";

describe("Realtime emissary session configuration", () => {
  it("configures a realtime audio session with the visibility contract and coordination tool", () => {
    const send = vi.fn();

    configureRealtimeEmissarySession({ send });

    const event = JSON.parse(send.mock.calls[0][0]);
    expect(event.type).toBe("session.update");
    expect(event.session.type).toBe("realtime");
    expect(event.session.output_modalities).toEqual(["audio"]);
    expect(event.session.audio.output.speed).toBe(1);
    expect(event.session.audio.input).toMatchObject({
      noise_reduction: null,
      transcription: { model: "gpt-realtime-whisper" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        create_response: true,
        interrupt_response: true,
      },
    });
    expect(event.session.max_output_tokens).toBe("inf");
    expect(event.session.instructions).toBe(REALTIME_SPOKESPERSON_INSTRUCTIONS);
    expect(event.session.instructions).toContain(
      "User speech is queued for the Expert but does not wake it",
    );
    expect(event.session.instructions).toContain(
      "never disclaim a capability because the other part performs it",
    );
    expect(event.session.instructions).toContain(
      "it calls `handoff` _before_ any substantive spoken answer",
    );
    expect(event.session.instructions).toContain(
      "never opens a handoff merely to reply to the Expert",
    );
    expect(event.session.instructions).toContain(
      "never speaks merely to acknowledge `CONTEXT`, `DISMISS`, or an internal message",
    );
    expect(event.session.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "handoff",
        parameters: {
          type: "object",
          properties: { message: expect.any(Object) },
          required: ["message"],
          additionalProperties: false,
        },
      }),
    ]);
  });

  it("maps semantic turn detection and advanced controls to the Realtime session", () => {
    const event = createRealtimeEmissarySessionUpdate({
      transcriptionModel: "gpt-live-transcribe",
      transcriptionLanguage: "en",
      transcriptionPrompt: "Berd, Tauri, emissary",
      turnDetection: "semantic_vad",
      eagerness: "high",
      interruptResponse: false,
      createResponse: false,
      noiseReduction: "far_field",
      reasoningEffort: "low",
      maxOutputTokens: 512,
    });

    expect(event.session).toMatchObject({
      reasoning: { effort: "low" },
      max_output_tokens: 512,
      audio: {
        input: {
          transcription: {
            model: "gpt-live-transcribe",
            language: "en",
            prompt: "Berd, Tauri, emissary",
          },
          noise_reduction: { type: "far_field" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            create_response: false,
            interrupt_response: false,
          },
        },
      },
    });
  });

  it("maps server VAD timing controls to the Realtime session", () => {
    const event = createRealtimeEmissarySessionUpdate({
      turnDetection: "server_vad",
      vadThreshold: 0.7,
      prefixPaddingMs: 450,
      silenceDurationMs: 850,
      idleTimeoutMs: 10_000,
    });

    expect(event.session).toMatchObject({
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            prefix_padding_ms: 450,
            silence_duration_ms: 850,
            idle_timeout_ms: 10_000,
          },
        },
      },
    });
  });

  it("does not send configurable reasoning to older Realtime models", () => {
    const event = createRealtimeEmissarySessionUpdate({
      model: "gpt-realtime-1.5",
      reasoningEffort: "high",
    });

    expect(event.session).not.toHaveProperty("reasoning");
  });

  it("exports the Expert visibility and proactive-send contract", () => {
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "response text land in the durable transcript",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "produce visible progress and result text",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "**Expert → Spokesperson messages** (`send_to_spokesperson`)",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "`SAY`—asks the Spokesperson to speak useful information now",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "finishing an Expert turn does not wake it",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "entire turn is an empty, zero-token success",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "no prose, no tools, no coordination",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "small talk belong to the Spokesperson",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "interrupted Spokesperson transcripts as best-effort",
    );
  });

  it("gives both roles the same one-assistant contract and canonical patterns", () => {
    expect(REALTIME_PROMPT_DOCUMENT).toContain("two parts of one brain");
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "one continuous conversation with one assistant",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain("### 1. Simple question");
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "### 2. Work that requires the Expert",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain("### 3. Useful elaboration");
    expect(
      REALTIME_SPOKESPERSON_INSTRUCTIONS.replace("Spokesperson", "{{ROLE}}"),
    ).toBe(REALTIME_PROMPT_DOCUMENT);
    expect(REALTIME_EXPERT_INSTRUCTIONS.replace("Expert", "{{ROLE}}")).toBe(
      REALTIME_PROMPT_DOCUMENT,
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "**Expert:** `[receives the exchange after the Spokesperson speaks; no output: zero tokens, no tools, no coordination]`",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "**Spokesperson → Expert, `HANDOFF handoff-7`:**",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "**Expert → Spokesperson, `SAY`, resolves `handoff-7`:**",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "**Expert → Spokesperson, `SAY`:** “A useful follow-up:",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "**User:** “How many months are in a year?”",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "You might wonder why the sky isn’t violet",
    );
  });
});

describe("RealtimeEmissaryProtocol", () => {
  it("reserves the user transcript position as soon as server VAD detects speech", () => {
    const protocol = new RealtimeEmissaryProtocol();

    expect(
      protocol.handle({
        type: "input_audio_buffer.speech_started",
        item_id: "user-1",
      }),
    ).toEqual([
      { type: "transcript.started", itemId: "user-1", speaker: "user" },
    ]);
  });

  it("streams provisional user and emissary transcripts before finalization", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(
      protocol.handle({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "user-1",
        delta: "How many",
      }),
    ).toEqual([
      {
        type: "transcript.updated",
        itemId: "user-1",
        speaker: "user",
        text: "How many",
      },
    ]);
    expect(
      protocol.handle({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "user-1",
        delta: " folders?",
      }),
    ).toEqual([
      {
        type: "transcript.updated",
        itemId: "user-1",
        speaker: "user",
        text: "How many folders?",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.delta",
        response_id: "response-1",
        item_id: "assistant-1",
        delta: "I'll check",
      }),
    ).toEqual([
      {
        type: "transcript.updated",
        itemId: "assistant-1",
        speaker: "emissary",
        text: "I'll check",
      },
    ]);
  });

  it("keeps multiple audio items from one response in one transcript", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.delta",
        response_id: "response-1",
        item_id: "assistant-1",
        delta: "Let me think about that.",
      }),
    ).toEqual([
      {
        type: "transcript.updated",
        itemId: "assistant-1",
        speaker: "emissary",
        text: "Let me think about that.",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.delta",
        response_id: "response-1",
        item_id: "assistant-2",
        delta: "I received a compact transcript.",
      }),
    ).toEqual([
      {
        type: "transcript.updated",
        itemId: "assistant-1",
        speaker: "emissary",
        text: "Let me think about that. I received a compact transcript.",
      },
    ]);
    protocol.handle({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      item_id: "assistant-1",
      transcript: "Let me think about that.",
    });
    protocol.handle({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      item_id: "assistant-2",
      transcript: "I received a compact transcript.",
    });
    expect(
      protocol.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([
      {
        type: "transcript.finalized",
        id: 1,
        itemId: "assistant-1",
        speaker: "emissary",
        text: "Let me think about that. I received a compact transcript.",
      },
    ]);
  });

  it("emits finalized user and emissary transcripts once in observed order", () => {
    const protocol = new RealtimeEmissaryProtocol();

    expect(
      protocol.handle({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-1",
        transcript: "  Hello there. ",
      }),
    ).toEqual([
      {
        type: "transcript.finalized",
        id: 1,
        itemId: "user-1",
        speaker: "user",
        text: "Hello there.",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.done",
        response_id: "response-1",
        item_id: "assistant-1",
        transcript: "Hi.",
      }),
    ).toEqual([]);
    expect(
      protocol.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([
      {
        type: "transcript.finalized",
        id: 2,
        itemId: "assistant-1",
        speaker: "emissary",
        text: "Hi.",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.done",
        response_id: "response-1",
        item_id: "assistant-1",
        transcript: "Hi.",
      }),
    ).toEqual([]);
  });

  it("forwards interrupted streamed text as explicitly best-effort", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_audio_transcript.delta",
      response_id: "response-1",
      item_id: "assistant-1",
      delta: "This part was heard",
    });
    protocol.handle({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      item_id: "assistant-1",
      transcript: "This part was never heard.",
    });
    expect(
      protocol.handle({
        type: "output_audio_buffer.cleared",
        response_id: "response-1",
      }),
    ).toEqual([
      {
        type: "transcript.finalized",
        id: 1,
        itemId: "assistant-1",
        speaker: "emissary",
        text: "This part was heard",
        interrupted: true,
      },
      {
        type: "emissary.playback_interrupted",
        responseId: "response-1",
      },
    ]);

    // A late terminal transcript for the interrupted response is still
    // generated text, not evidence that the user heard it.
    protocol.handle({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      item_id: "assistant-1",
      transcript: "This part was never heard.",
    });

    expect(
      protocol.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([]);
  });

  it("fails loudly on Realtime server and transcription errors", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(() =>
      protocol.handle({
        type: "error",
        error: { message: "bad session configuration" },
      }),
    ).toThrow("bad session configuration");
    expect(() =>
      protocol.handle({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "audio unintelligible" },
      }),
    ).toThrow("audio unintelligible");
  });

  it("ignores empty and non-terminal transcript events", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.delta",
        item_id: "assistant-1",
        delta: "partial",
      }),
    ).toEqual([]);
    expect(
      protocol.handle({
        type: "response.output_audio_transcript.done",
        item_id: "assistant-1",
        transcript: "  ",
      }),
    ).toEqual([]);
  });

  it("assembles a handoff call from streamed arguments", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "handoff",
        call_id: "call-1",
      },
    });
    protocol.handle({
      type: "response.function_call_arguments.delta",
      call_id: "call-1",
      delta: '{"message":"Please investigate',
    });
    protocol.handle({
      type: "response.function_call_arguments.delta",
      call_id: "call-1",
      delta: ' this."}',
    });

    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
      }),
    ).toEqual([
      {
        type: "handoff",
        callId: "call-1",
        message: "Please investigate this.",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        name: "handoff",
        call_id: "call-1",
        arguments: '{"message":"duplicate"}',
      }),
    ).toEqual([]);
  });

  it("rejects malformed handoff arguments", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        name: "handoff",
        call_id: "call-1",
        arguments: '{"message":"hello","unexpected":true}',
      }),
    ).toEqual([
      {
        type: "tool_call.invalid",
        callId: "call-1",
        toolName: "handoff",
        error: "handoff accepts only a message argument",
      },
    ]);
  });

  it("returns unterminated tool arguments to the emissary for a silent retry", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "handoff",
        call_id: "call-broken",
      },
    });
    protocol.handle({
      type: "response.function_call_arguments.delta",
      call_id: "call-broken",
      delta: '{"message":"Please inspect',
    });

    const [invalidCall] = protocol.handle({
      type: "response.function_call_arguments.done",
      call_id: "call-broken",
    });
    expect(invalidCall).toMatchObject({
      type: "tool_call.invalid",
      callId: "call-broken",
      toolName: "handoff",
    });
    expect(invalidCall).toHaveProperty(
      "error",
      expect.stringMatching(/unterminated|JSON/i),
    );
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        call_id: "call-broken",
      }),
    ).toEqual([]);

    expect(
      createInvalidToolCallOutput(
        "call-broken",
        "handoff",
        "JSON Parse error: Unterminated string",
      ),
    ).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-broken",
        output: JSON.stringify({
          accepted: false,
          reason: "invalid_arguments",
          error:
            "handoff arguments were invalid: JSON Parse error: Unterminated string. Retry this tool call with complete valid JSON. Do not speak this internal error to the user.",
        }),
      },
    });
  });
});

describe("master message injection", () => {
  it("adds typed user text and creates a response while idle", () => {
    const coordinator = new RealtimeResponseCoordinator();

    expect(coordinator.requestTypedUserMessage("Typed hello")).toEqual({
      status: "sent",
      events: [
        { type: "input_audio_buffer.clear" },
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Typed hello" }],
          },
        },
        { type: "response.create" },
      ],
    });
  });

  it("interrupts active generation and playback for typed user text", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.requestMasterMessage({ message: "context", mode: "say" });
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });

    expect(coordinator.requestTypedUserMessage("New direction")).toEqual({
      status: "interrupting",
      events: [
        { type: "response.cancel", response_id: "response-1" },
        { type: "output_audio_buffer.clear" },
        { type: "input_audio_buffer.clear" },
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "New direction" }],
          },
        },
      ],
    });

    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "output_audio_buffer.cleared",
        response_id: "response-1",
      }),
    ).toEqual([{ type: "response.create" }]);
  });

  it("lets a server-VAD barge-in supersede a response before its terminal event", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });
    coordinator.requestMasterMessage({
      message: "Queued master context.",
      mode: "say",
    });

    expect(
      coordinator.handle({
        type: "response.created",
        response: { id: "response-2" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "cancelled" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-2", status: "completed" },
      }),
    ).toEqual([
      {
        type: "response.create",
        response: {
          instructions:
            "Speak this Expert message to the user now, preserving its meaning: Queued master context. Be natural, concise, and accurate. Do not call tools.",
          tools: [],
          tool_choice: "none",
        },
      },
    ]);

    expect(
      coordinator.requestMasterMessage({
        message: "A later result.",
        mode: "say",
      }),
    ).toMatchObject({ status: "queued" });
  });

  it("releases handoffs from a SAY displaced by a server-VAD response", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.requestMasterMessage({
      message: "The answer is 21.",
      mode: "say",
      resolvedHandoffIds: ["handoff-1"],
    });
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });

    coordinator.handle({
      type: "response.created",
      response: { id: "response-2" },
    });

    expect(coordinator.takeCompletedHandoffIds()).toEqual([]);
    expect(coordinator.takeFailedHandoffIds()).toEqual(["handoff-1"]);
  });

  it("creates no emissary event for empty master output", () => {
    const coordinator = new RealtimeResponseCoordinator();

    expect(() =>
      coordinator.requestMasterMessage({ message: "   ", mode: "context" }),
    ).toThrow("master message cannot be empty");

    // Rejection leaves the coordinator idle; no hidden response lifecycle was
    // created for the empty master turn.
    expect(
      coordinator.requestMasterMessage({
        message: "Useful guidance.",
        mode: "context",
      }).status,
    ).toBe("sent");
  });

  it("injects private master context without requesting a response", () => {
    const coordinator = new RealtimeResponseCoordinator();

    expect(
      coordinator.requestMasterMessage({
        message: "Keep this in mind.",
        mode: "context",
        eventId: "context-1",
      }),
    ).toEqual({
      status: "sent",
      events: [
        {
          type: "conversation.item.create",
          event_id: "context-1",
          item: {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "Private context from the Expert for a future natural turn. Do not respond to this item now:\nKeep this in mind.",
              },
            ],
          },
        },
      ],
    });
  });

  it("injects a master SAY message and requests a tool-free response", () => {
    const coordinator = new RealtimeResponseCoordinator();
    const transport = { send: vi.fn() };
    const events = coordinator.requestMasterMessage({
      message: "Relay the result.",
      mode: "say",
      eventId: "m1",
    }).events;
    sendRealtimeEvents(transport, events);

    expect(
      transport.send.mock.calls.map(([event]) => JSON.parse(event)),
    ).toEqual([
      {
        type: "conversation.item.create",
        event_id: "m1",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: "The Expert has decided the following information must be spoken to the user now. Speak it naturally and accurately without adding filler or offering more help:\nRelay the result.",
            },
          ],
        },
      },
      {
        type: "response.create",
        response: {
          instructions:
            "Speak this Expert message to the user now, preserving its meaning: Relay the result. Be natural, concise, and accurate. Do not call tools.",
          tools: [],
          tool_choice: "none",
        },
      },
    ]);
  });

  it("speaks queued SAY messages separately and resolves handoffs after playback", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.requestMasterMessage({
      message: "First answer.",
      mode: "say",
      resolvedHandoffIds: ["handoff-1"],
    });
    expect(
      coordinator.requestMasterMessage({
        message: "Second answer.",
        mode: "say",
        resolvedHandoffIds: ["handoff-2"],
      }).status,
    ).toBe("queued");

    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });
    coordinator.handle({
      type: "response.done",
      response: { id: "response-1", status: "completed" },
    });
    expect(
      coordinator.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "response.create",
        response: expect.objectContaining({
          instructions: expect.stringContaining("Second answer."),
        }),
      }),
    ]);
    expect(coordinator.takeCompletedHandoffIds()).toEqual(["handoff-1"]);

    coordinator.handle({
      type: "response.created",
      response: { id: "response-2" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-2",
    });
    coordinator.handle({
      type: "output_audio_buffer.stopped",
      response_id: "response-2",
    });
    coordinator.handle({
      type: "response.done",
      response: { id: "response-2", status: "completed" },
    });
    expect(coordinator.takeCompletedHandoffIds()).toEqual(["handoff-2"]);
  });

  it("keeps a handoff unresolved when its SAY produces no audio", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.requestMasterMessage({
      message: "Answer.",
      mode: "say",
      resolvedHandoffIds: ["handoff-1"],
    });
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "response.done",
      response: { id: "response-1", status: "completed" },
    });

    expect(coordinator.takeCompletedHandoffIds()).toEqual([]);
    expect(coordinator.takeFailedHandoffIds()).toEqual(["handoff-1"]);
  });

  it("serializes a tool-output follow-up behind the response that called the tool", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    const toolOutput = {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "{}" },
    };

    expect(coordinator.requestToolOutput(toolOutput)).toEqual({
      status: "queued",
      events: [toolOutput],
    });
    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      }),
    ).toEqual([{ type: "response.create" }]);
  });

  it("records an accepted handoff result without waking the emissary", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    const toolOutput = {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "{}" },
    };

    expect(coordinator.recordToolOutput(toolOutput)).toEqual({
      status: "sent",
      events: [toolOutput],
    });
    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      }),
    ).toEqual([]);
  });

  it("coalesces a Master answer into the queued tool follow-up after playback", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });

    coordinator.recordToolOutput({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "{}" },
    });
    expect(
      coordinator.requestMasterMessage({
        message: "The answer is 26.",
        mode: "say",
      }),
    ).toMatchObject({ status: "queued" });
    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "response.create",
        response: expect.objectContaining({ tools: [], tool_choice: "none" }),
      }),
    ]);
  });

  it("requests a response immediately for a tool output while idle", () => {
    const coordinator = new RealtimeResponseCoordinator();
    const toolOutput = {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "{}" },
    };

    expect(coordinator.requestToolOutput(toolOutput)).toEqual({
      status: "sent",
      events: [toolOutput, { type: "response.create" }],
    });
  });

  it("sends SAY immediately without cancelling when the session is idle", () => {
    const coordinator = new RealtimeResponseCoordinator();

    const request = coordinator.requestMasterMessage({
      message: "Keep this in mind.",
      mode: "say",
    });

    expect(request.status).toBe("sent");
    expect(request.events.map((event) => event.type)).toEqual([
      "conversation.item.create",
      "response.create",
    ]);
    expect(request.events).not.toContainEqual(
      expect.objectContaining({ type: "response.cancel" }),
    );
  });

  it("lets completed generated audio finish playing when no master message is queued", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });

    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([]);

    expect(
      coordinator.requestMasterMessage({
        message: "A later result.",
        mode: "say",
      }),
    ).toMatchObject({ status: "sent" });
  });

  it("injects master context immediately but waits for active playback before responding", () => {
    const coordinator = new RealtimeResponseCoordinator();
    coordinator.handle({
      type: "response.created",
      response: { id: "response-1" },
    });
    coordinator.handle({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });

    expect(
      coordinator.requestMasterMessage({
        message: "First master message.",
        mode: "say",
      }),
    ).toEqual({
      status: "queued",
      events: [
        expect.objectContaining({
          type: "conversation.item.create",
          item: expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("First master message."),
              }),
            ],
          }),
        }),
      ],
    });
    expect(
      coordinator.requestMasterMessage({
        message: "Second master message.",
        mode: "say",
      }),
    ).toEqual({
      status: "queued",
      events: [
        expect.objectContaining({
          type: "conversation.item.create",
          item: expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("Second master message."),
              }),
            ],
          }),
        }),
      ],
    });

    expect(
      coordinator.handle({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      }),
    ).toEqual([]);
    expect(
      coordinator.handle({
        type: "output_audio_buffer.stopped",
        response_id: "response-1",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "response.create",
        response: expect.objectContaining({ tools: [], tool_choice: "none" }),
      }),
    ]);
  });

  it("includes an accepted handoff id in the tool result", () => {
    expect(
      createHandoffToolOutput("call-2", {
        accepted: true,
        handoff_id: "handoff-4",
      }),
    ).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-2",
        output: '{"accepted":true,"handoff_id":"handoff-4"}',
      },
    });
  });
});

describe("DirectMessagePipe", () => {
  it("starts each call in its assigned cursor namespace", () => {
    const pipe = new DirectMessagePipe(12_000_000);

    expect(pipe.cursor("master")).toBe(12_000_000);
    expect(pipe.cursor("emissary")).toBe(12_000_000);
    expect(
      pipe.send({
        sender: "emissary",
        cursor: 12_000_000,
        message: "Call-scoped message.",
      }),
    ).toMatchObject({
      accepted: true,
      outbound: { id: 12_000_001, senderCursor: 12_000_000 },
    });
  });

  it("allows the active sender to queue multiple messages", () => {
    const pipe = new DirectMessagePipe();
    const first = pipe.send({
      sender: "emissary",
      cursor: 0,
      message: "First detail.",
    });
    const second = pipe.send({
      sender: "emissary",
      cursor: 0,
      message: "Second detail.",
    });
    expect(first).toMatchObject({
      accepted: true,
      outbound: { id: 1, sender: "emissary" },
    });
    expect(second).toMatchObject({
      accepted: true,
      outbound: { id: 2, sender: "emissary" },
    });
    if (!first.accepted || !second.accepted)
      throw new Error("expected an accepted batch");

    expect(
      pipe.send({ sender: "master", cursor: 0, message: "Reply." }),
    ).toEqual({
      accepted: false,
      reason: "pipe_busy",
      cursor: 0,
    });
    expect(
      pipe.send({ sender: "master", cursor: 2, message: "Reply." }),
    ).toMatchObject({
      accepted: true,
      cursor: 2,
      outbound: { id: 3, sender: "master", senderCursor: 2 },
    });
    expect(pipe.cursor("master")).toBe(2);
  });

  it("requires the cursor for the complete pending batch", () => {
    const pipe = new DirectMessagePipe();
    const first = pipe.send({ sender: "master", cursor: 0, message: "One." });
    const second = pipe.send({ sender: "master", cursor: 0, message: "Two." });
    if (!first.accepted || !second.accepted)
      throw new Error("expected an accepted batch");

    expect(
      pipe.send({ sender: "emissary", cursor: 1, message: "Too soon." }),
    ).toEqual({
      accepted: false,
      reason: "pipe_busy",
      cursor: 0,
    });
    expect(
      pipe.send({ sender: "emissary", cursor: 2, message: "Now reply." }),
    ).toMatchObject({
      accepted: true,
      cursor: 2,
      outbound: { senderCursor: 2 },
    });
    expect(pipe.cursor("emissary")).toBe(2);
  });

  it("rejects a stale send without consuming the pending direction", () => {
    const pipe = new DirectMessagePipe();
    const master = pipe.send({
      sender: "master",
      cursor: 0,
      message: "Result.",
    });
    if (!master.accepted) throw new Error("expected accepted message");

    expect(
      pipe.send({
        sender: "emissary",
        cursor: 0,
        message: "Stale reply.",
      }),
    ).toEqual({
      accepted: false,
      reason: "pipe_busy",
      cursor: 0,
    });
    const reply = pipe.send({
      sender: "emissary",
      cursor: master.outbound.id,
      message: "Fresh reply.",
    });
    expect(reply).toMatchObject({
      accepted: true,
      cursor: 1,
      outbound: {
        sender: "emissary",
        recipient: "master",
        senderCursor: 1,
      },
    });
    expect(pipe.cursor("emissary")).toBe(master.outbound.id);
  });

  it("exposes the latest inbound cursor to trusted delivery boundaries", () => {
    const pipe = new DirectMessagePipe();
    const first = pipe.send({
      sender: "master",
      cursor: 0,
      message: "Context.",
    });
    const second = pipe.send({
      sender: "master",
      cursor: 0,
      message: "More context.",
    });
    if (!first.accepted || !second.accepted)
      throw new Error("expected an accepted batch");

    expect(pipe.deliveryCursor("emissary")).toBe(second.outbound.id);
    expect(pipe.deliveryCursor("master")).toBe(0);

    const reverse = pipe.send({
      sender: "emissary",
      cursor: pipe.deliveryCursor("emissary"),
      message: "Transcript.",
    });
    expect(reverse).toMatchObject({
      accepted: true,
      cursor: second.outbound.id,
      outbound: { sender: "emissary" },
    });
    expect(pipe.deliveryCursor("emissary")).toBe(second.outbound.id);
    expect(pipe.deliveryCursor("master")).toBe(
      reverse.accepted ? reverse.outbound.id : -1,
    );
  });
});
