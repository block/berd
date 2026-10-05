// Fake-driven tests for the panel send flows. The FakeSendRpc records
// call ORDER — the create flows are ordering guarantees, so the tests
// assert sequences, not just outcomes. Pins:
//
// - live prompt: echo first, thinking during, run-end cleanup after
// - deferred agent create: create → epoch check → commit → onCommitted →
//   in-flight released BEFORE the prompt (the response streams live)
// - deferred fresh create: same shape, null agent binding
// - implicit fresh: no armed selection and no session yet → fresh create
// - cancel racing a create: no commit, no prompt, nothing mutated
// - double-send guard: busy sends mutate NOTHING and busy is synchronous
// - run gate: a second send while a run is active on the
//   live session bounces — goosed allows one run per session; deferred
//   creates pass the gate (they target a NEW session); a late orphaned
//   finally never clears the new owner's gate (generation tokens)
// - epoch-orphaned finally blocks mutate nothing
// - perch preamble: wire text carries it, the echo stays bare, and the
//   guidance ledger burns ONLY after confirmed delivery with the REAL
//   session id (deferred creates decide full-vs-slim before the id exists)

import { beforeEach, describe, expect, test } from "vitest";

import {
  SendController,
  type SendRpc,
  type SendStatusSink,
} from "./sendController";
import { plainText } from "./chatModels";
import { markGuidanceSent, resetGuidanceLedger } from "./sendSource";
import { SessionStore } from "./sessionStore";
import type { AgentInfo, SessionActivity } from "../hooks/useSession";

const agent: AgentInfo = {
  agentId: "panda",
  name: "Panda",
  systemPrompt: "be panda",
  provider: null,
  model: null,
};

class FakeSendRpc implements SendRpc {
  calls: string[] = [];
  lastContent: Array<Record<string, unknown>> | null = null;
  createResult: () => Promise<string> = () => Promise.resolve("new-session");
  promptResult: () => Promise<void> = () => Promise.resolve();

  prompt(args: {
    sessionId: string;
    content: Array<Record<string, unknown>>;
  }): Promise<void> {
    this.calls.push(`prompt:${args.sessionId}`);
    this.lastContent = args.content;
    return this.promptResult();
  }
  createAgentSession(info: AgentInfo): Promise<string> {
    this.calls.push(`createAgent:${info.agentId}`);
    return this.createResult();
  }
  createFreshSession(): Promise<string> {
    this.calls.push("createFresh");
    return this.createResult();
  }
  cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`);
    return Promise.resolve();
  }
}

interface SinkLog {
  activity: SessionActivity[];
  sendErrors: Array<string | null>;
  inFlight: boolean[];
  committed: number;
  publishes: number;
}

function harness() {
  const store = new SessionStore();
  const rpc = new FakeSendRpc();
  const log: SinkLog = {
    activity: [],
    sendErrors: [],
    inFlight: [],
    committed: 0,
    publishes: 0,
  };
  const sink: SendStatusSink = {
    setActivity: (activity) => log.activity.push(activity),
    setLastSendError: (error) => log.sendErrors.push(error),
    setAgentSendInFlight: (inFlight) => log.inFlight.push(inFlight),
    onCommitted: () => {
      log.committed += 1;
    },
    publish: () => {
      log.publishes += 1;
    },
  };
  const controller = new SendController(store, rpc, sink);
  return { store, rpc, log, controller };
}

// The guidance ledger is module-scoped (survives component remounts by
// design) — reset per test so ordering can't leak.
beforeEach(() => {
  resetGuidanceLedger();
});

describe("SendController live prompt", () => {
  test("happy path: echo, thinking, prompt content, run-end cleanup", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("hello");
    expect(rpc.calls).toEqual(["prompt:live-1"]);
    expect(rpc.lastContent).toEqual([{ type: "text", text: "hello" }]);
    expect(store.messages).toHaveLength(1); // the optimistic echo
    // thinking during, none after (run-end signal).
    expect(log.activity).toEqual(["thinking", "none"]);
    expect(log.sendErrors.filter((e) => e !== null)).toHaveLength(0);
  });

  test("image blocks ride the same prompt content array", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("look", [
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
    expect(rpc.lastContent).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
  });

  test("prompt failure lands on lastSendError and still cleans up", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("live-1");
    rpc.promptResult = () => Promise.reject(new Error("boom"));
    await controller.send("hello");
    // Errors render through formatAcpErrorMessage: the bare message, and
    // an ACP RequestError's data payload instead of "Invalid params".
    expect(log.sendErrors).toContain("boom");
    expect(log.activity[log.activity.length - 1]).toBe("none");
  });

  test("ACP errors surface their data payload, not the generic message", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("live-1");
    const wireError = Object.assign(new Error("Invalid params"), {
      name: "RequestError",
      code: -32602,
      data: "session already has active run `run_1`; use _goose/unstable/session/steer",
    });
    rpc.promptResult = () => Promise.reject(wireError);
    await controller.send("hello");
    expect(log.sendErrors).toContain(
      "session already has active run `run_1`; use _goose/unstable/session/steer",
    );
  });

  test("empty text is a no-op", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("   ");
    expect(rpc.calls).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });
});

describe("SendController deferred agent create", () => {
  test("create → commit → in-flight released BEFORE the live-streaming prompt", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("old-live");
    store.arm({ kind: "agent", agent });
    await controller.send("hello");
    expect(rpc.calls).toEqual(["createAgent:panda", "prompt:new-session"]);
    expect(store.sessionId).toBe("new-session");
    expect(store.activeAgentId).toBe("panda");
    expect(log.committed).toBe(1);
    // true (entry), false (commit — streaming takes over), false (finally).
    expect(log.inFlight).toEqual([true, false, false]);
    // The prompt carries the BARE text (no preamble machinery in PR1).
    expect(rpc.lastContent).toEqual([{ type: "text", text: "hello" }]);
  });

  test("cancel racing the create commits nothing and prompts nothing", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("old-live");
    store.arm({ kind: "agent", agent });
    let resolveCreate!: (id: string) => void;
    rpc.createResult = () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      });
    const send = controller.send("hello");
    store.cancelArm(); // epoch bump: the user went back
    resolveCreate("orphan-session");
    await send;
    expect(rpc.calls).toEqual(["createAgent:panda"]); // no prompt
    expect(store.sessionId).toBe("old-live"); // restored, not committed
    expect(log.committed).toBe(0);
    // Orphaned finally: the cancel path owns state now — the in-flight
    // flag was set at entry and must NOT be force-cleared by the stale
    // flow (select() clears it).
    expect(log.inFlight).toEqual([true]);
  });

  test("create failure is a send error; nothing committed", async () => {
    const { store, rpc, log, controller } = harness();
    store.arm({ kind: "agent", agent });
    rpc.createResult = () => Promise.reject(new Error("create failed"));
    await controller.send("hello");
    expect(log.sendErrors).toContain("create failed");
    expect(store.sessionId).toBeNull();
    expect(log.committed).toBe(0);
  });
});

describe("SendController deferred fresh create", () => {
  test("armed fresh: create → commit(null) → prompt", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("old-live");
    store.restoreAgentBinding("panda");
    store.arm({ kind: "fresh" });
    await controller.send("hello");
    expect(rpc.calls).toEqual(["createFresh", "prompt:new-session"]);
    expect(store.activeAgentId).toBeNull(); // default avatar
    expect(log.committed).toBe(1);
  });

  test("implicit fresh: nothing armed, no session yet", async () => {
    const { store, rpc, log, controller } = harness();
    await controller.send("hello");
    expect(rpc.calls).toEqual(["createFresh", "prompt:new-session"]);
    expect(store.sessionId).toBe("new-session");
    expect(log.committed).toBe(1);
  });
});

describe("SendController composer gate", () => {
  test("busy is synchronous and a bounced send mutates nothing", async () => {
    const { store, rpc, log, controller } = harness();
    store.arm({ kind: "agent", agent });
    let resolveCreate!: (id: string) => void;
    rpc.createResult = () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      });
    const first = controller.send("first");
    expect(controller.busy).toBe(true); // synchronous view
    const echoCount = store.messages.length;
    const errorCount = log.sendErrors.length;
    await controller.send("second"); // bounced
    expect(store.messages).toHaveLength(echoCount); // no second echo
    expect(log.sendErrors).toHaveLength(errorCount); // no cleared errors
    expect(rpc.calls.filter((c) => c.startsWith("createAgent"))).toHaveLength(
      1,
    );
    resolveCreate("new-session");
    await first;
    expect(controller.busy).toBe(false);
  });
});

describe("SendController run gate", () => {
  test("second send while the live session's run is active bounces and mutates nothing", async () => {
    const { store, rpc, log, controller } = harness();
    store.resetForAdopt("live-1");
    let resolvePrompt!: () => void;
    rpc.promptResult = () =>
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    const first = controller.send("first");
    expect(controller.busy).toBe(true); // synchronous — the composer's check
    const echoCount = store.messages.length;
    const errorWrites = log.sendErrors.length;
    await controller.send("second"); // bounced: goosed allows one run/session
    expect(store.messages).toHaveLength(echoCount); // no second echo
    expect(log.sendErrors).toHaveLength(errorWrites); // no cleared errors
    expect(rpc.calls).toEqual(["prompt:live-1"]); // no second prompt
    resolvePrompt();
    await first;
    expect(controller.busy).toBe(false); // run ended: the gate lifts
    rpc.promptResult = () => Promise.resolve();
    await controller.send("third");
    expect(rpc.calls).toEqual(["prompt:live-1", "prompt:live-1"]);
  });

  test("create gate lifts at COMMIT (no double-create) but the run gate holds through the first streamed turn", async () => {
    const { store, rpc, log, controller } = harness();
    store.arm({ kind: "agent", agent });
    let resolveFirstPrompt!: () => void;
    rpc.promptResult = () =>
      new Promise<void>((resolve) => {
        resolveFirstPrompt = resolve;
      });
    const first = controller.send("hello");
    await new Promise((r) => setTimeout(r, 0)); // create resolves; commit runs; prompt pending
    expect(log.committed).toBe(1);
    // REVISES review 5.1: the create gate still lifts at commit (a
    // follow-up can never double-create), but the first response is an
    // ACTIVE RUN on the committed session — goosed rejects a concurrent
    // prompt, so Enter mid-first-stream bounces like any mid-run send.
    expect(controller.busy).toBe(true);
    const echoCount = store.messages.length;
    await controller.send("mid-stream"); // bounced: mutates nothing
    expect(store.messages).toHaveLength(echoCount);
    expect(rpc.calls.filter((c) => c.startsWith("createAgent"))).toHaveLength(
      1,
    );
    expect(rpc.calls.filter((c) => c === "prompt:new-session")).toHaveLength(1);
    resolveFirstPrompt();
    await first;
    // Run ended: follow-ups take the normal prompt path.
    expect(controller.busy).toBe(false);
    rpc.promptResult = () => Promise.resolve();
    await controller.send("follow-up");
    expect(rpc.calls.filter((c) => c === "prompt:new-session")).toHaveLength(2);
  });

  test("an armed selection escapes the run gate; the old run's late finally cannot clear the new owner's gate", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    let resolveOldPrompt!: () => void;
    rpc.promptResult = () =>
      new Promise<void>((resolve) => {
        resolveOldPrompt = resolve;
      });
    const oldSend = controller.send("on the live session");
    expect(controller.busy).toBe(true);
    // The user picks an agent mid-stream: the next send targets a NEW
    // session — one-run-per-session is a per-session rule, so the gate
    // opens for the deferred create.
    store.arm({ kind: "agent", agent });
    expect(controller.busy).toBe(false);
    let resolveNewPrompt!: () => void;
    rpc.promptResult = () =>
      new Promise<void>((resolve) => {
        resolveNewPrompt = resolve;
      });
    const newSend = controller.send("first message to the agent");
    await new Promise((r) => setTimeout(r, 0)); // create resolves; commit; new prompt pending
    expect(rpc.calls).toEqual([
      "prompt:live-1",
      "createAgent:panda",
      "prompt:new-session",
    ]);
    // The OLD run ends while the new one streams: its stale finally
    // must not clear the gate the new run owns (generation token).
    resolveOldPrompt();
    await oldSend;
    expect(controller.busy).toBe(true);
    resolveNewPrompt();
    await newSend;
    expect(controller.busy).toBe(false);
  });
});

describe("SendController perch preamble + guidance ledger", () => {
  const makePreamble = (fullGuidance: boolean) =>
    fullGuidance
      ? "[Perched on: Chrome]\nguidance sentence"
      : "[Perched on: Chrome]";

  test("wire text carries the preamble; the echo stays the bare words", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("hello", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nhello",
      },
    ]);
    expect(plainText(store.messages[0])).toBe("hello"); // bare echo
  });

  test("first perched send is full guidance, the second is slim (ledger burns at delivery)", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("first", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nfirst",
      },
    ]);
    await controller.send("second", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      { type: "text", text: "[Perched on: Chrome]\n\nsecond" },
    ]);
  });

  test("a FAILED send leaves the ledger unburned — the retry carries full guidance again", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    rpc.promptResult = () => Promise.reject(new Error("boom"));
    await controller.send("first", undefined, makePreamble);
    rpc.promptResult = () => Promise.resolve();
    await controller.send("retry", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nretry",
      },
    ]);
  });

  test("a bare send (no preamble) never burns the ledger", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send("plain", undefined, null);
    await controller.send("perched now", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nperched now",
      },
    ]);
  });

  test("deferred create is ALWAYS full guidance and burns the REAL id, not the parked one", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("parked-session");
    // The parked session already saw guidance — must not matter.
    markGuidanceSent("parked-session");
    store.arm({ kind: "agent", agent });
    await controller.send("hello", undefined, makePreamble);
    // Full guidance rode the create's prompt despite the burned park.
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nhello",
      },
    ]);
    // The NEW session's ledger burned at delivery: next send is slim.
    await controller.send("again", undefined, makePreamble);
    expect(rpc.lastContent).toEqual([
      { type: "text", text: "[Perched on: Chrome]\n\nagain" },
    ]);
  });

  test("create failure leaves the new session's ledger unburned", async () => {
    const { store, rpc, controller } = harness();
    store.arm({ kind: "agent", agent });
    rpc.createResult = () => Promise.reject(new Error("create failed"));
    await controller.send("hello", undefined, makePreamble);
    rpc.createResult = () => Promise.resolve("new-session");
    await controller.send("retry", undefined, makePreamble);
    // The successful retry's prompt still carries FULL guidance.
    expect(rpc.lastContent).toEqual([
      {
        type: "text",
        text: "[Perched on: Chrome]\nguidance sentence\n\nretry",
      },
    ]);
  });

  test("images ride behind the preamble text block", async () => {
    const { store, rpc, controller } = harness();
    store.resetForAdopt("live-1");
    await controller.send(
      "look",
      [{ type: "image", data: "abc", mimeType: "image/png" }],
      makePreamble,
    );
    expect(rpc.lastContent).toEqual([
      { type: "text", text: "[Perched on: Chrome]\nguidance sentence\n\nlook" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
  });
});

describe("SendController stop", () => {
  test("cancels the live session; no-op without one", async () => {
    const { store, rpc, controller } = harness();
    await controller.stop(); // no live session
    expect(rpc.calls).toHaveLength(0);
    store.resetForAdopt("live-1");
    await controller.stop();
    expect(rpc.calls).toEqual(["cancel:live-1"]);
  });
});
