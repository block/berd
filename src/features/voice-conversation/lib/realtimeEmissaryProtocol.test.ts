import { describe, expect, it } from "vitest";
import {
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
