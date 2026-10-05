// Send flows for the desktop agent panel: the normal prompt, the deferred
// agent create, and the deferred fresh create. Plain class with injected
// RPC + status-sink ports (the panelState pattern) so the flow sequencing
// — where the epoch-guard bugs live — is fake-testable.
//
// In-process simplification (vs the out-of-process prototype): sessions
// are created directly over the panel's own ACP connection with the
// persona bound at create time (personaId + provider in _meta, system
// prompt + model pin applied post-create). The first response STREAMS
// LIVE like any other send — there is no external dispatch, no adopt
// step, no export backfill, and no orphan-reuse bookkeeping (commit is
// local-only and cannot fail separately from create).
//
// Epoch rule (house): epoch guards cancel the CLIENT half of a two-sided
// transaction. Every await is followed by a store.epoch re-check before
// any mutation. A cancel racing a create leaves the created session as a
// harmless orphan in the session list — nothing local committed.
//
// Run gate: goosed rejects a second session/prompt while a
// run is active on the session (invalid_params: "session already has
// active run …; use _goose/unstable/session/steer"). The main app queues
// or steers mid-stream sends; the panel's product call is DISALLOW —
// send() bounces them BEFORE any mutation (no echo, no cleared error),
// and `busy` exposes the gate synchronously so the composer can bounce
// BEFORE clearing the draft. A deferred create targets a NEW session and
// passes the gate. Steering is the graduation-era follow-up.
//
// Perch preamble: send() optionally takes a makePreamble closure (the
// composer builds it from live perch identity). The preamble is
// WIRE-ONLY — the echo stays the user's bare words — and this controller
// is the guidance ledger's SOLE reader/marker: only it knows which
// session a send actually targets (a deferred create's id exists only
// after commit), and it marks AFTER confirmed delivery, never
// optimistically — a failed send leaves the ledger unburned so the
// retry carries full guidance again.

import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

import { markGuidanceSent, shouldSendFullGuidanceFor } from "./sendSource";
import type { SessionStore } from "./sessionStore";
import type { AgentInfo, SessionActivity } from "../hooks/useSession";

export interface SendRpc {
  /** session/prompt with the full content array (text + any images).
   *  Resolves when the turn completes (run-end signal). */
  prompt(args: {
    sessionId: string;
    content: Array<Record<string, unknown>>;
  }): Promise<void>;
  /** Creates an agent-bound session: session/new carrying personaId +
   *  provider meta, then system prompt + model pin. Returns the id. */
  createAgentSession(agent: AgentInfo): Promise<string>;
  /** Creates a plain session (the fresh "Berd" chat). */
  createFreshSession(): Promise<string>;
  cancel(sessionId: string): Promise<void>;
}

/** React setters, grouped. The controller never touches React directly —
 *  the hook wires these to useState setters and its publish(). */
export interface SendStatusSink {
  setActivity(activity: SessionActivity): void;
  setLastSendError(error: string | null): void;
  setAgentSendInFlight(inFlight: boolean): void;
  /** A deferred create committed: the hook mirrors the store's canonical
   *  values into React state and persists the session/agent ids. Called
   *  AFTER store.commit(). */
  onCommitted(): void;
  publish(): void;
}

let messageCounter = 0;
const localMessageId = (): string => `local-${Date.now()}-${messageCounter++}`;

function contentFor(
  text: string,
  imageBlocks: Array<Record<string, unknown>> | null,
): Array<Record<string, unknown>> {
  return [{ type: "text", text }, ...(imageBlocks ?? [])];
}

export class SendController {
  // Synchronous re-entry guard: a second Enter while a create is in
  // flight must not spawn a second session. State-based guards are
  // async; this field closes the same-tick window.
  private createInFlight = false;
  // Ownership token for the gate. The gate releases at COMMIT (review
  // 5.1), so a first send's outer finally can still be pending when a
  // SECOND deferred create (re-arm mid-stream + send) has taken the
  // gate — the stale finally must not stomp the new owner's true.
  private createGeneration = 0;
  // A run is active on the live session (a prompt is awaiting run-end).
  // goosed rejects concurrent prompts per session — send() bounces
  // mid-stream sends instead of erroring on the wire.
  private promptInFlight = false;
  // Ownership token, same pattern as createGeneration: a re-arm
  // mid-stream starts a NEW flow whose prompt takes the gate; the
  // ORPHANED flow's late finally must not clear the new owner's true.
  private promptGeneration = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly rpc: SendRpc,
    private readonly sink: SendStatusSink,
  ) {}

  /** SYNCHRONOUS live view of the send gate — true when send() would
   *  bounce. The composer must check this BEFORE clearing the draft:
   *  React state lags a render, and a send() bounced off the internal
   *  guards would otherwise eat the message silently.
   *
   *  Mirrors send()'s own decision exactly: a create in flight gates
   *  everything; an active run gates only sends TARGETING the live
   *  session — an armed selection (or a panel with nothing adopted)
   *  sends via a NEW session and passes (one-run-per-session is a
   *  per-session rule). */
  get busy(): boolean {
    if (this.createInFlight) return true;
    if (!this.promptInFlight) return false;
    const pendingCreate =
      this.store.pendingSelection !== null || this.store.sessionId === null;
    return !pendingCreate;
  }

  /** Stop the in-flight run. Fire-and-forget: session/cancel resolves the
   *  pending prompt normally with stopReason "cancelled" — the existing
   *  run-end handling (activity reset, finishStreamingMessage) cleans up.
   *  Failure is a quiet no-op: the run keeps streaming, which the UI
   *  already shows honestly. */
  async stop(): Promise<void> {
    const target = this.store.liveSessionId;
    if (target === null) return;
    try {
      await this.rpc.cancel(target);
    } catch {
      // Cancel is best-effort; the running state remains visibly true.
    }
  }

  /** Resolves true when the message was DISPATCHED (echo appended, a
   *  delivery attempt ran — even if it later failed onto lastSendError)
   *  and false when it BOUNCED off a gate (nothing mutated, the text was
   *  not consumed). The composer clears its draft before awaiting, so a
   *  false return is its signal to restore the eaten text — the sync
   *  busy check closes the same-tick window, but any composer that
   *  awaits between its gate check and send() (the perch capture path)
   *  needs the return value for the async gap. */
  async send(
    text: string,
    imageBlocks?: Array<Record<string, unknown>>,
    makePreamble?: ((fullGuidance: boolean) => string | null) | null,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    // Re-entry guard: bounced sends mutate NOTHING — no echo, no rpc, no
    // cleared errors (the composer gate contract).
    if (this.createInFlight) return false;
    const pending = this.store.pendingSelection;
    const sessionId = this.store.sessionId;
    // Deferred create: an armed selection, or the very first message of a
    // panel that had nothing to adopt (implicit fresh chat).
    const pendingCreate = pending !== null || sessionId === null;
    // Run gate: a second prompt while a run is active on the live session
    // would be rejected by goosed (invalid_params: "session already has
    // active run") — bounce it BEFORE the echo, same mutate-nothing
    // contract. A deferred create targets a NEW session and passes.
    if (!pendingCreate && this.promptInFlight) return false;
    this.sink.setLastSendError(null);
    // Guidance decision: a deferred create always gets full guidance
    // (new session, agent never saw it); otherwise the LIVE session's
    // ledger decides. Decided here — not in the composer — because only
    // this controller knows which session the send targets.
    const fullGuidance = shouldSendFullGuidanceFor(pendingCreate, sessionId);
    const preamble = makePreamble ? makePreamble(fullGuidance) : null;
    const id = localMessageId();
    // Optimistic echo first (house rule: composer clears before the
    // send). The echo is the user's BARE words — the preamble is
    // wire-only; the transcript never shows the bracket line.
    this.store.appendLocalEcho({
      id,
      text: trimmed,
      imageBlocks: imageBlocks ?? null,
    });
    this.sink.publish();

    // Wire text carries the identity preamble; the echo above stays bare.
    const wireText = preamble ? `${preamble}\n\n${trimmed}` : trimmed;
    // Ledger burns only when a full-guidance preamble actually rides this
    // send (a bare send or slim preamble must not burn it).
    const markGuidance = preamble !== null && fullGuidance;

    if (pendingCreate) {
      this.createInFlight = true;
      this.createGeneration += 1;
      const generation = this.createGeneration;
      try {
        if (pending?.kind === "agent") {
          await this.sendCreatingAgentSession(
            pending.agent,
            wireText,
            markGuidance,
            imageBlocks ?? null,
          );
        } else {
          await this.sendCreatingFreshSession(
            wireText,
            markGuidance,
            imageBlocks ?? null,
          );
        }
      } finally {
        // Safety net for the failure paths (the success path released at
        // commit): only the CURRENT gate owner may clear — a superseded
        // send's late finally leaves the new create's gate alone.
        if (this.createGeneration === generation) {
          this.createInFlight = false;
        }
      }
      // Dispatched: the echo landed and a create/prompt attempt ran —
      // failures surfaced on lastSendError, but the text was consumed.
      return true;
    }

    this.sink.setActivity("thinking");
    this.promptInFlight = true;
    this.promptGeneration += 1;
    const promptGeneration = this.promptGeneration;
    try {
      await this.rpc.prompt({
        sessionId,
        content: contentFor(wireText, imageBlocks ?? null),
      });
      // Guidance delivered: marked only after the prompt resolved — a
      // failed send leaves the ledger unburned so the retry carries full
      // guidance again.
      if (markGuidance) markGuidanceSent(sessionId);
    } catch (error) {
      this.sink.setLastSendError(formatAcpErrorMessage(error));
    } finally {
      // Prompt future completing is a run-end signal — for THIS run. The
      // whole cleanup is ownership-gated (generation token): if a newer
      // run has taken the gate (re-arm mid-stream + send), the stale
      // finally must not clear the gate, stomp activity to "none", or
      // finish-stream the reducer the NEW run is streaming into.
      if (this.promptGeneration === promptGeneration) {
        this.promptInFlight = false;
        this.sink.setActivity("none");
        this.store.finishStreamingMessage();
        this.sink.publish();
      }
    }
    // Dispatched: the echo landed and a delivery attempt ran — failures
    // surfaced on lastSendError, but the text was consumed.
    return true;
  }

  /** First send under a pending agent: create the persona-bound session
   *  on our own connection, commit, then prompt — the response streams
   *  live. A cancel racing the create leaves an unadopted orphan
   *  session; nothing local mutated (the epoch check gates commit). */
  private async sendCreatingAgentSession(
    agent: AgentInfo,
    wireText: string,
    markGuidance: boolean,
    imageBlocks: Array<Record<string, unknown>> | null,
  ): Promise<void> {
    const s = this.store;
    const epoch = s.epoch;
    let promptGeneration: number | null = null;
    this.sink.setAgentSendInFlight(true);
    this.sink.setActivity("thinking");
    try {
      const newSessionId = await this.rpc.createAgentSession(agent);
      if (s.epoch !== epoch) return; // cancelled: the orphan stays unadopted

      s.commit(newSessionId, agent.agentId);
      this.sink.onCommitted();
      // Committed: from here the response streams live — "starting up"
      // would be a lie, so the agent-send flag clears NOW, and the
      // CREATE gate lifts (review 5.1: post-commit follow-ups can't
      // double-create). The RUN gate takes over for this first streamed
      // turn: goosed rejects a second prompt while the run
      // is active, so Enter mid-stream bounces quietly until run-end.
      this.createInFlight = false;
      this.sink.setAgentSendInFlight(false);
      this.promptInFlight = true;
      this.promptGeneration += 1;
      promptGeneration = this.promptGeneration;
      await this.rpc.prompt({
        sessionId: newSessionId,
        content: contentFor(wireText, imageBlocks),
      });
      // Ledger burns with the REAL id, only after the prompt delivered.
      if (markGuidance) markGuidanceSent(newSessionId);
    } catch (error) {
      // Pre-commit failures (create) and post-commit failures (prompt on
      // the NEW session) are both send errors — same channel.
      if (s.epoch === epoch) {
        this.sink.setLastSendError(formatAcpErrorMessage(error));
      }
    } finally {
      // The run gate clears for its owner regardless of epoch — the
      // generation token (not the epoch) is its ownership rule.
      if (
        promptGeneration !== null &&
        this.promptGeneration === promptGeneration
      ) {
        this.promptInFlight = false;
      }
      if (s.epoch === epoch) {
        this.sink.setAgentSendInFlight(false);
        this.sink.setActivity("none");
        s.finishStreamingMessage();
        this.sink.publish();
      }
    }
  }

  /** First send under a pending FRESH selection (the "Berd" entry), or
   *  the implicit first chat when nothing was adoptable at attach. */
  private async sendCreatingFreshSession(
    wireText: string,
    markGuidance: boolean,
    imageBlocks: Array<Record<string, unknown>> | null,
  ): Promise<void> {
    const s = this.store;
    const epoch = s.epoch;
    let promptGeneration: number | null = null;
    this.sink.setAgentSendInFlight(true); // composer gate covers fresh creates too
    this.sink.setActivity("thinking");
    try {
      const newSessionId = await this.rpc.createFreshSession();
      if (s.epoch !== epoch) return; // cancelled: orphan stays unadopted
      s.commit(newSessionId, null); // fresh session: default avatar
      this.sink.onCommitted();
      this.createInFlight = false; // create gate lifts at commit (review 5.1)
      this.sink.setAgentSendInFlight(false);
      // Run gate holds through the first streamed turn.
      this.promptInFlight = true;
      this.promptGeneration += 1;
      promptGeneration = this.promptGeneration;
      await this.rpc.prompt({
        sessionId: newSessionId,
        content: contentFor(wireText, imageBlocks),
      });
      if (markGuidance) markGuidanceSent(newSessionId);
    } catch (error) {
      if (s.epoch === epoch) {
        this.sink.setLastSendError(formatAcpErrorMessage(error));
      }
    } finally {
      if (
        promptGeneration !== null &&
        this.promptGeneration === promptGeneration
      ) {
        this.promptInFlight = false;
      }
      if (s.epoch === epoch) {
        this.sink.setAgentSendInFlight(false);
        this.sink.setActivity("none");
        s.finishStreamingMessage();
        this.sink.publish();
      }
    }
  }
}
