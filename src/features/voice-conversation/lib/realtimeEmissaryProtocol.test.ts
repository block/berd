import { describe, expect, it } from "vitest";
import {
  DirectMessagePipe,
  REALTIME_EXPERT_INSTRUCTIONS,
  REALTIME_PROMPT_DOCUMENT,
  REALTIME_SPOKESPERSON_INSTRUCTIONS,
  createHandoffToolOutput,
  createInvalidToolCallOutput,
} from "./realtimeEmissaryProtocol";

describe("Realtime spokesperson prompt", () => {
  it("exports the Expert visibility and proactive-send contract", () => {
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "response text land in the durable transcript",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "produce visible progress and result text",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "**Expert → Spokesperson delivery intents.**",
    );
    expect(REALTIME_EXPERT_INSTRUCTIONS).toContain(
      "`SAY` asks the Spokesperson to speak useful information now",
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

  it("keeps delivery timing host-neutral and handoff enforcement durable", () => {
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "The host delivers relevant conversation events to the Expert",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "prevents an Expert turn from completing while a required handoff remains unresolved",
    );
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "there is no fixed timer or retry count",
    );
    expect(REALTIME_PROMPT_DOCUMENT).not.toContain(
      "User speech is queued for the Expert but does not wake it",
    );
    expect(REALTIME_PROMPT_DOCUMENT).not.toContain("up to three times");
  });

  it("gives both roles the same one-assistant contract", () => {
    expect(REALTIME_PROMPT_DOCUMENT).toContain("two parts of one brain");
    expect(REALTIME_PROMPT_DOCUMENT).toContain(
      "one continuous conversation with one assistant",
    );
    expect(
      REALTIME_SPOKESPERSON_INSTRUCTIONS.replace("Spokesperson", "{{ROLE}}"),
    ).toBe(REALTIME_PROMPT_DOCUMENT);
    expect(REALTIME_EXPERT_INSTRUCTIONS.replace("Expert", "{{ROLE}}")).toBe(
      REALTIME_PROMPT_DOCUMENT,
    );
  });
});

describe("Realtime tool results", () => {
  it("includes the accepted handoff id", () => {
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

  it("returns invalid arguments as a silent retry instruction", () => {
    expect(
      createInvalidToolCallOutput("call-3", "handoff", "bad JSON"),
    ).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-3",
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
    expect(
      pipe.send({ sender: "master", cursor: 0, message: "Reply." }),
    ).toEqual({ accepted: false, reason: "pipe_busy", cursor: 0 });
    expect(
      pipe.send({ sender: "master", cursor: 2, message: "Reply." }),
    ).toMatchObject({
      accepted: true,
      cursor: 2,
      outbound: { id: 3, sender: "master", senderCursor: 2 },
    });
  });

  it("requires the cursor for the complete pending batch", () => {
    const pipe = new DirectMessagePipe();
    pipe.send({ sender: "master", cursor: 0, message: "One." });
    pipe.send({ sender: "master", cursor: 0, message: "Two." });

    expect(
      pipe.send({ sender: "emissary", cursor: 1, message: "Too soon." }),
    ).toEqual({ accepted: false, reason: "pipe_busy", cursor: 0 });
    expect(
      pipe.send({ sender: "emissary", cursor: 2, message: "Now reply." }),
    ).toMatchObject({
      accepted: true,
      cursor: 2,
      outbound: { senderCursor: 2 },
    });
  });

  it("rejects stale sends without consuming pending input", () => {
    const pipe = new DirectMessagePipe();
    const message = pipe.send({
      sender: "master",
      cursor: 0,
      message: "Result.",
    });
    if (!message.accepted) throw new Error("expected accepted message");

    expect(
      pipe.send({ sender: "emissary", cursor: 0, message: "Stale reply." }),
    ).toEqual({ accepted: false, reason: "pipe_busy", cursor: 0 });
    expect(
      pipe.send({
        sender: "emissary",
        cursor: message.outbound.id,
        message: "Fresh reply.",
      }),
    ).toMatchObject({ accepted: true, cursor: 1 });
  });

  it("exposes the latest inbound cursor at trusted delivery boundaries", () => {
    const pipe = new DirectMessagePipe();
    pipe.send({ sender: "master", cursor: 0, message: "Context." });
    const second = pipe.send({
      sender: "master",
      cursor: 0,
      message: "More context.",
    });
    if (!second.accepted) throw new Error("expected an accepted batch");

    expect(pipe.deliveryCursor("emissary")).toBe(second.outbound.id);
    expect(pipe.deliveryCursor("master")).toBe(0);
  });
});
