// Table tests for the session/transcript state machine (extracted from
// useSession). Pins the seams where the prototype's admission bugs
// lived, previously asserted only in comments:
//
// - admission control: armed view admits nothing;
//   parked reducer keeps streaming; foreign sessions drop; null live
//   admits everything (startup replay)
// - armed-swap discards the scratch reducer but keeps the original park
//
// - cancel restores a transcript that kept streaming while parked
// - epoch bumps ONLY on arm/cancelArm
// - commit clears park + armed and rebinds the agent

import { describe, expect, test } from "vitest";

import { AcpUpdate, type AcpNotification } from "./acpNotification";
import { plainText } from "./chatModels";
import { SessionStore } from "./sessionStore";

function chunk(
  sessionId: string,
  messageId: string,
  text: string,
): AcpNotification {
  return {
    sessionId,
    update: new AcpUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    }),
  };
}

const agentSelection = {
  kind: "agent" as const,
  agent: {
    agentId: "panda",
    name: "Panda",
    systemPrompt: "",
    provider: null,
    model: null,
  },
};

describe("SessionStore admission", () => {
  test("null liveSessionId admits everything (startup replay)", () => {
    const store = new SessionStore();
    expect(store.admit(chunk("any-session", "m1", "hello"))).toBe("painted");
    expect(store.messages).toHaveLength(1);
  });

  test("attached: live session paints, foreign sessions drop", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    expect(store.admit(chunk("live-1", "m1", "yes"))).toBe("painted");
    expect(store.admit(chunk("other", "m2", "no"))).toBe("dropped");
    expect(store.messages).toHaveLength(1);
    expect(plainText(store.messages[0])).toBe("yes");
  });

  test("armed: live-session chunks park (not discarded), everything else drops", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.arm(agentSelection);
    expect(store.messages).toHaveLength(0);
    // Late chunk from the parked session: applied to the PARKED reducer.
    expect(store.admit(chunk("live-1", "m1", "kept streaming"))).toBe("parked");
    // The armed view stays empty — nothing painted.
    expect(store.messages).toHaveLength(0);
    // Foreign session while armed: dropped outright.
    expect(store.admit(chunk("other", "m2", "noise"))).toBe("dropped");
  });

  test("cancel restores a transcript that kept streaming while parked", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "before arm"));
    store.arm(agentSelection);
    store.admit(chunk("live-1", "m1", " … and after"));
    store.cancelArm();
    expect(store.messages).toHaveLength(1);
    expect(plainText(store.messages[0])).toBe("before arm … and after");
    // Restored view paints again.
    expect(store.admit(chunk("live-1", "m2", "live"))).toBe("painted");
  });

  test("armed with nothing parked before first attach: everything drops", () => {
    const store = new SessionStore();
    store.arm(agentSelection);
    // parked exists but liveSessionId is null — no notification matches it.
    expect(store.admit(chunk("any", "m1", "x"))).toBe("dropped");
  });
});

describe("SessionStore arming lifecycle", () => {
  test("arm parks the current transcript and empties the view", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("old-agent");
    store.admit(chunk("live-1", "m1", "history"));
    store.arm(agentSelection);
    expect(store.armed).toBe(true);
    expect(store.pendingSelection).toEqual(agentSelection);
    expect(store.messages).toHaveLength(0);
    // sessionId still holds the parked id while armed (the F1 shape —
    // callers must NOT key sends off it; the store keeps it for restore).
    expect(store.sessionId).toBe("live-1");
    expect(store.activeAgentId).toBe("old-agent");
  });

  test("swap-while-armed keeps the original park and discards the scratch (finding 1)", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "original"));
    store.arm(agentSelection);
    // A failed/orphaned send left an echo in the armed scratch.
    store.appendLocalEcho({ id: "ghost", text: "orphaned echo" });
    expect(store.messages).toHaveLength(1);
    // Swap to a different selection: scratch replaced, park untouched.
    store.arm({ kind: "fresh" });
    expect(store.messages).toHaveLength(0); // no ghost in the new chat
    expect(store.pendingSelection).toEqual({ kind: "fresh" });
    store.cancelArm();
    expect(store.messages).toHaveLength(1);
    expect(plainText(store.messages[0])).toBe("original");
  });

  test("cancel restores sessionId and agent binding verbatim", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("old-agent");
    store.arm(agentSelection);
    store.cancelArm();
    expect(store.armed).toBe(false);
    expect(store.pendingSelection).toBeNull();
    expect(store.sessionId).toBe("live-1");
    expect(store.activeAgentId).toBe("old-agent");
  });

  test("cancel with nothing parked is safe", () => {
    const store = new SessionStore();
    store.cancelArm();
    expect(store.armed).toBe(false);
    expect(store.sessionId).toBeNull();
  });

  test("epoch bumps exactly on arm/cancelArm and nowhere else", () => {
    const store = new SessionStore();
    expect(store.epoch).toBe(0);
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("a");
    store.admit(chunk("live-1", "m1", "x"));
    store.appendLocalEcho({ id: "e1", text: "y" });
    store.finishStreamingMessage();
    expect(store.epoch).toBe(0);
    store.arm(agentSelection);
    expect(store.epoch).toBe(1);
    store.arm({ kind: "fresh" }); // swap bumps too (every select() call)
    expect(store.epoch).toBe(2);
    store.cancelArm();
    expect(store.epoch).toBe(3);
    store.commit("s2", null);
    expect(store.epoch).toBe(3); // commit is NOT a selection change
  });
});

describe("SessionStore commit", () => {
  test("commit makes the new session live, drops the park, binds the agent", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "old history"));
    store.arm(agentSelection);
    store.appendLocalEcho({ id: "e1", text: "first message" });
    store.commit("new-session", "panda");
    expect(store.armed).toBe(false);
    expect(store.pendingSelection).toBeNull();
    expect(store.sessionId).toBe("new-session");
    expect(store.liveSessionId).toBe("new-session");
    expect(store.activeAgentId).toBe("panda");
    // The echo survives commit (the armed scratch becomes the live view).
    expect(store.messages).toHaveLength(1);
    // The park is history: cancel-shaped restore is impossible now.
    store.cancelArm();
    expect(store.sessionId).toBe("new-session");
    // New live session paints; the old one no longer does.
    expect(store.admit(chunk("new-session", "m2", "reply"))).toBe("painted");
    expect(store.admit(chunk("live-1", "m3", "stale"))).toBe("dropped");
  });

  test("fresh commit clears the agent binding (default avatar)", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("panda");
    store.arm({ kind: "fresh" });
    store.commit("fresh-session", null);
    expect(store.activeAgentId).toBeNull();
  });
});

describe("SessionStore transcript operations", () => {
  test("appendLocalEcho carries image blocks with valid shapes only", () => {
    const store = new SessionStore();
    store.appendLocalEcho({
      id: "e1",
      text: "look at this",
      imageBlocks: [
        { data: "abc123", mimeType: "image/png" },
        { data: 42, mimeType: "image/png" }, // malformed: skipped
      ],
    });
    const message = store.messages[0];
    expect(message.content).toHaveLength(2); // text + one valid image
    expect(message.content[1]).toEqual({
      type: "image",
      data: "abc123",
      mimeType: "image/png",
    });
  });

  test("messages returns a fresh array identity each call (publish contract)", () => {
    const store = new SessionStore();
    store.appendLocalEcho({ id: "e1", text: "x" });
    expect(store.messages).not.toBe(store.messages);
  });

  test("paintedStreaming reflects the live reducer runtime", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    expect(store.paintedStreaming()).toBe(false);
    store.admit(chunk("live-1", "m1", "streaming now"));
    expect(store.paintedStreaming()).toBe(true);
    store.finishStreamingMessage();
    expect(store.paintedStreaming()).toBe(false);
  });
});

describe("SessionStore resetForAdopt", () => {
  test("unarmed: fresh reducer before replay — re-adopt does not duplicate chunks", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "hello"));
    // Reconnect: re-adopt the same session; session/load replays m1.
    // Without the fresh reducer, appendText would concatenate the
    // replayed chunk onto the old copy ("hellohello").
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "hello"));
    expect(store.messages).toHaveLength(1);
    expect(plainText(store.messages[0])).toBe("hello");
  });

  test("unarmed: null clears the live session (stale persisted id)", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "old"));
    store.resetForAdopt(null);
    expect(store.sessionId).toBeNull();
    expect(store.liveSessionId).toBeNull();
    expect(store.messages).toHaveLength(0);
    // Null live id admits everything again (startup semantics).
    expect(store.admit(chunk("any-session", "m2", "new"))).toBe("painted");
  });

  test("unarmed: a stale id (null) unlinks the agent binding too", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("panda");
    store.resetForAdopt(null);
    // No session, no binding — an agent avatar over a null session would
    // be the wrong face until the next commit (review Check 4 LOW).
    expect(store.sessionId).toBeNull();
    expect(store.activeAgentId).toBeNull();
    // A live re-adopt does NOT touch the binding (adopt restores it from
    // persistence separately, in the hook).
    store.restoreAgentBinding("panda");
    store.resetForAdopt("live-2");
    expect(store.activeAgentId).toBe("panda");
  });

  test("armed: a stale id (null) unlinks the PARK's binding — cancel cannot restore the wrong face", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.restoreAgentBinding("panda");
    store.arm(agentSelection);
    // Reconnect finds the persisted id stale while a selection is armed.
    store.resetForAdopt(null);
    store.cancelArm();
    // The park restored: null session AND null binding (previously the
    // pre-arm agent leaked through, arming a fresh send under an agent
    // avatar).
    expect(store.sessionId).toBeNull();
    expect(store.activeAgentId).toBeNull();
    expect(store.messages).toHaveLength(0);
  });

  test("armed: replay rebuilds the PARK, the scratch view stays empty, cancel restores it", () => {
    const store = new SessionStore();
    store.resetForAdopt("live-1");
    store.admit(chunk("live-1", "m1", "pre-arm history"));
    store.arm(agentSelection);
    // Reconnect while armed: the park's reducer is replaced, the armed
    // scratch view must not repaint.
    store.resetForAdopt("live-1");
    expect(store.admit(chunk("live-1", "m1", "replayed history"))).toBe(
      "parked",
    );
    expect(store.messages).toHaveLength(0); // scratch untouched
    store.cancelArm();
    expect(store.sessionId).toBe("live-1");
    expect(store.messages).toHaveLength(1);
    expect(plainText(store.messages[0])).toBe("replayed history");
  });
});
