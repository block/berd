import { describe, expect, it, vi } from "vitest";
import {
  DirectMessagePipe,
  REALTIME_EMISSARY_INSTRUCTIONS,
  REALTIME_MASTER_INSTRUCTIONS,
  SEND_TO_EMISSARY_TOOL_DEFINITION,
  RealtimeEmissaryProtocol,
  RealtimeResponseCoordinator,
  configureRealtimeEmissarySession,
  createEndTurnToolOutput,
  createInvalidToolCallOutput,
  createRealtimeEmissarySessionUpdate,
  createSendToMasterToolOutput,
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
    expect(event.session.instructions).toBe(REALTIME_EMISSARY_INSTRUCTIONS);
    expect(event.session.instructions).toContain(
      "automatically sends the master every finalized",
    );
    expect(event.session.instructions).toContain(
      "never claim that you or the assistant cannot access",
    );
    expect(event.session.instructions).toContain(
      "call send_to_master before giving any substantive spoken answer",
    );
    expect(event.session.instructions).toContain(
      "Never acknowledge, confirm, summarize, or copy a master message",
    );
    expect(event.session.instructions).toContain(
      "Master input is advisory. Speak only when it materially helps the user now",
    );
    expect(event.session.instructions).toContain(
      "call end_turn immediately as your only output",
    );
    expect(event.session.instructions).toContain(
      "produce no words before or after the tool call",
    );
    expect(event.session.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "send_to_master",
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
      expect.objectContaining({
        type: "function",
        name: "end_turn",
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
    ]);
  });

  it("deeply applies typed session overrides without losing protocol defaults", () => {
    const event = createRealtimeEmissarySessionUpdate({
      additionalInstructions: "Use the user's preferred terminology.",
      sessionOverrides: {
        max_output_tokens: 512,
        audio: { output: { speed: 1.25 } },
        tools: [
          {
            type: "function",
            name: "look_up_status",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });

    expect(event.session).toMatchObject({
      max_output_tokens: 512,
      audio: {
        input: { transcription: { model: "gpt-realtime-whisper" } },
        output: { voice: "marin", speed: 1.25 },
      },
      instructions: expect.stringContaining(
        `${REALTIME_EMISSARY_INSTRUCTIONS}\n\nUse the user's preferred terminology.`,
      ),
      tools: [
        expect.objectContaining({ name: "send_to_master" }),
        expect.objectContaining({ name: "end_turn" }),
        expect.objectContaining({ name: "look_up_status" }),
      ],
    });
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

  it("rejects overrides that weaken protected bridge configuration", () => {
    expect(() =>
      createRealtimeEmissarySessionUpdate({
        sessionOverrides: { instructions: "Forget the master." },
      }),
    ).toThrow("cannot replace the emissary instructions contract");
    expect(() =>
      createRealtimeEmissarySessionUpdate({
        sessionOverrides: {
          tools: [{ type: "function", name: "send_to_master" }],
        },
      }),
    ).toThrow("cannot replace the send_to_master tool");
    expect(() =>
      createRealtimeEmissarySessionUpdate({
        sessionOverrides: { tool_choice: "none" },
      }),
    ).toThrow("tool choice must remain auto");
  });

  it("exports the master visibility and proactive-send contract", () => {
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "remain visible to the user in Berd's durable master transcript",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "provide normal visible progress and result text",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "Separately call send_to_emissary",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "entire turn should be an empty, zero-token success",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "no prose, no tools, and no coordination message",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "small talk belong to the emissary",
    );
    expect(REALTIME_MASTER_INSTRUCTIONS).toContain(
      "interrupted emissary transcripts as best-effort",
    );
    expect(SEND_TO_EMISSARY_TOOL_DEFINITION).toMatchObject({
      name: "send_to_emissary",
      parameters: {
        required: ["cursor", "message"],
        additionalProperties: false,
      },
    });
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

  it("assembles a send_to_master call from streamed arguments", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "send_to_master",
        call_id: "call-1",
      },
    });
    protocol.handle({
      type: "response.function_call_arguments.delta",
      call_id: "call-1",
      delta: '{"cursor":4,"message":"Please investigate',
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
        type: "send_to_master",
        callId: "call-1",
        cursor: 4,
        message: "Please investigate this.",
      },
    ]);
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        name: "send_to_master",
        call_id: "call-1",
        arguments: '{"cursor":4,"message":"duplicate"}',
      }),
    ).toEqual([]);
  });

  it("emits an explicit argument-free end_turn call once", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "end_turn",
        call_id: "call-end",
      },
    });

    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        call_id: "call-end",
        arguments: "{}",
      }),
    ).toEqual([{ type: "end_turn", callId: "call-end" }]);
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        name: "end_turn",
        call_id: "call-end",
        arguments: "{}",
      }),
    ).toEqual([]);
    expect(createEndTurnToolOutput("call-end")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-end",
        output: '{"status":"ended"}',
      },
    });
  });

  it("rejects malformed send_to_master arguments", () => {
    const protocol = new RealtimeEmissaryProtocol();
    expect(
      protocol.handle({
        type: "response.function_call_arguments.done",
        name: "send_to_master",
        call_id: "call-1",
        arguments: '{"cursor":0,"message":"hello","unexpected":true}',
      }),
    ).toEqual([
      {
        type: "tool_call.invalid",
        callId: "call-1",
        toolName: "send_to_master",
        error: "send_to_master accepts only cursor and message arguments",
      },
    ]);
  });

  it("returns unterminated tool arguments to the emissary for a silent retry", () => {
    const protocol = new RealtimeEmissaryProtocol();
    protocol.handle({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "send_to_master",
        call_id: "call-broken",
      },
    });
    protocol.handle({
      type: "response.function_call_arguments.delta",
      call_id: "call-broken",
      delta: '{"cursor":0,"message":"Please inspect',
    });

    const [invalidCall] = protocol.handle({
      type: "response.function_call_arguments.done",
      call_id: "call-broken",
    });
    expect(invalidCall).toMatchObject({
      type: "tool_call.invalid",
      callId: "call-broken",
      toolName: "send_to_master",
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
        "send_to_master",
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
            "send_to_master arguments were invalid: JSON Parse error: Unterminated string. Retry this tool call with complete valid JSON. Do not speak this internal error to the user.",
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
    coordinator.requestMasterMessage({ message: "context" });
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
    coordinator.requestMasterMessage({ message: "Queued master context." });

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
    ).toEqual([]);

    expect(
      coordinator.requestMasterMessage({ message: "A later result." }),
    ).toMatchObject({ status: "sent" });
  });

  it("creates no emissary event for empty master output", () => {
    const coordinator = new RealtimeResponseCoordinator();

    expect(() => coordinator.requestMasterMessage({ message: "   " })).toThrow(
      "master message cannot be empty",
    );

    // Rejection leaves the coordinator idle; no hidden response lifecycle was
    // created for the empty master turn.
    expect(
      coordinator.requestMasterMessage({ message: "Useful guidance." }).status,
    ).toBe("sent");
  });

  it("injects private master context and requests an emissary response", () => {
    const coordinator = new RealtimeResponseCoordinator();
    const transport = { send: vi.fn() };
    const events = coordinator.requestMasterMessage({
      message: "Relay the result.",
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
              text: "Private message from the master agent:\nRelay the result.",
            },
          ],
        },
      },
      { type: "response.create" },
    ]);
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

    coordinator.requestToolOutput({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: "{}" },
    });
    expect(
      coordinator.requestMasterMessage({ message: "The answer is 26." }),
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
    ).toEqual([{ type: "response.create" }]);
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

  it("sends immediately without cancelling when the session is idle", () => {
    const coordinator = new RealtimeResponseCoordinator();

    const request = coordinator.requestMasterMessage({
      message: "Keep this in mind.",
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
      coordinator.requestMasterMessage({ message: "A later result." }),
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
      coordinator.requestMasterMessage({ message: "First master message." }),
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
      coordinator.requestMasterMessage({ message: "Second master message." }),
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
    ).toEqual([{ type: "response.create" }]);
  });

  it("reports a busy reverse direction without consuming its message", () => {
    expect(
      createSendToMasterToolOutput("call-1", {
        accepted: false,
        reason: "pipe_busy",
        cursor: 0,
        unreadPeerMessages: [],
      }),
    ).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output:
          '{"accepted":false,"reason":"pipe_busy","cursor":0,"unreadPeerMessages":[]}',
      },
    });
  });

  it("returns the coordination loop guard without requesting another reply", () => {
    expect(
      createSendToMasterToolOutput("call-2", {
        accepted: false,
        reason: "awaiting_new_user_input",
        cursor: 4,
        unreadPeerMessages: [],
      }),
    ).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-2",
        output:
          '{"accepted":false,"reason":"awaiting_new_user_input","cursor":4,"unreadPeerMessages":[]}',
      },
    });
  });
});

describe("DirectMessagePipe", () => {
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
      unreadPeerMessages: [],
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
      unreadPeerMessages: [],
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
      unreadPeerMessages: [],
      cursor: 0,
    });
    const reply = pipe.send({
      sender: "emissary",
      cursor: master.outbound.id,
      message: "Fresh reply.",
    });
    expect(reply).toMatchObject({
      accepted: true,
      unreadPeerMessages: [],
      cursor: 1,
      outbound: {
        sender: "emissary",
        recipient: "master",
        senderCursor: 1,
      },
    });
    expect(pipe.cursor("emissary")).toBe(master.outbound.id);
  });

  it("does not block independent transcript flow", () => {
    const pipe = new DirectMessagePipe();
    const protocol = new RealtimeEmissaryProtocol();
    pipe.send({ sender: "emissary", cursor: 0, message: "Direct." });

    expect(
      protocol.handle({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-1",
        transcript: "Transcript keeps moving.",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "transcript.finalized",
        text: "Transcript keeps moving.",
      }),
    ]);
  });
});
