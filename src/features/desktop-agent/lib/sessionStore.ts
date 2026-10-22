// Session/transcript state machine (extracted from useSession).
//
// Owns the armed/parked/commit lifecycle and notification admission — the
// seam where three HIGH review bugs lived (armed-swap ghost transcript,
// composer keying off the parked sessionId, late chunks painting into the
// armed view). Plain class, no React, no invoke: useSession holds one
// instance in a ref and mirrors the canonical values into React state
// after each mutating call.
//
// Deferred chats: arming is PURE UI STATE — nothing is
// created until the first send (product rule). The current transcript is
// parked, the view goes empty, and cancelling restores the park verbatim
// (including the agent binding, so the avatar comes back too).
//
// Admission control: while armed the transcript is a
// fresh empty view — late chunks from the parked session must not paint
// into it. They are NOT discarded: they apply to the parked
// reducer, so cancelling restores a transcript that kept streaming while
// parked. When not armed, only the live session's notifications paint; a
// null liveSessionId accepts everything (startup replay arrives before
// attach resolves).

import type { AcpNotification } from "./acpNotification";
import { emptyRuntime, type ChatMessage } from "./chatModels";
import { ChatTranscriptReducer } from "./chatTranscriptReducer";
import type { PendingSelection } from "../hooks/useSession";

export type AdmitResult = "painted" | "parked" | "dropped";

export class SessionStore {
  private reducer = new ChatTranscriptReducer({
    messages: [],
    runtime: emptyRuntime(),
  });
  // The transcript parked when a selection was armed — restored verbatim
  // if the selection is cancelled before the first send.
  private parked: {
    sessionId: string | null;
    reducer: ChatTranscriptReducer;
    activeAgentId: string | null;
  } | null = null;
  private armedInternal = false;
  private pendingInternal: PendingSelection | null = null;
  private sessionIdInternal: string | null = null;
  // Which session the stream is allowed to paint. Distinct from sessionId
  // only transiently (mid-commit); null accepts everything.
  private liveSessionIdInternal: string | null = null;
  private activeAgentIdInternal: string | null = null;
  // Monotonic guard: a session switch mid-flow must orphan in-flight work
  // (create flows capture it at entry and compare at every await). Bumped
  // ONLY by arm()/cancelArm() — the store's selection changes.
  private epochInternal = 0;

  get sessionId(): string | null {
    return this.sessionIdInternal;
  }
  get liveSessionId(): string | null {
    return this.liveSessionIdInternal;
  }
  get activeAgentId(): string | null {
    return this.activeAgentIdInternal;
  }
  get pendingSelection(): PendingSelection | null {
    return this.pendingInternal;
  }
  get armed(): boolean {
    return this.armedInternal;
  }
  get epoch(): number {
    return this.epochInternal;
  }
  /** Fresh-array snapshot — the reducer mutates in place and the React
   *  view needs a new identity (the old publish()). */
  get messages(): ChatMessage[] {
    return [...this.reducer.messages];
  }

  /** Adopt (or re-adopt after reconnect): fresh reducer + new live id,
   *  BEFORE session/load streams the replay. The replay repaints the
   *  transcript from server truth — re-loading into the old reducer
   *  would duplicate text chunks (appendText concatenates). Passing null
   *  clears the live session entirely (a stale persisted id: nothing to
   *  adopt; the first send creates).
   *
   *  Re-adopt WHILE ARMED (reconnect racing a pending selection): the
   *  armed scratch view must survive untouched — the replay belongs to
   *  the parked session, so the PARK's reducer is the one replaced (the
   *  replay rebuilds it; cancel still restores a correct transcript). */
  resetForAdopt(sessionId: string | null): void {
    const fresh = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    if (this.armedInternal && this.parked !== null) {
      this.parked = {
        ...this.parked,
        sessionId,
        reducer: fresh,
        // A stale id (null) unlinks the park's SESSION — keeping its
        // agent binding would have cancelArm restore an agent avatar
        // over a null session: the next send would create a FRESH chat
        // under the wrong face until commit corrected it (review
        // Check 4 LOW: stale-adopt-while-armed park binding).
        activeAgentId: sessionId === null ? null : this.parked.activeAgentId,
      };
    } else {
      this.reducer = fresh;
      // Same rule unarmed: no session, no binding.
      if (sessionId === null) this.activeAgentIdInternal = null;
    }
    this.sessionIdInternal = sessionId;
    this.liveSessionIdInternal = sessionId;
  }

  /** Agent binding restored from server-side run state at attach. */
  restoreAgentBinding(agentId: string): void {
    this.activeAgentIdInternal = agentId;
  }

  /** Arms a deferred chat. Re-selecting while already pending swaps the
   *  selection without stacking parks — the original session stays the
   *  single restore point. The armed scratch reducer is ALWAYS replaced
   * : a swap keeps the park but must discard the
   *  scratch — a failed or orphaned send's echo in it would otherwise
   *  reappear in the NEW chat's transcript on the next publish. */
  arm(selection: PendingSelection): void {
    this.epochInternal += 1;
    if (this.parked === null) {
      this.parked = {
        sessionId: this.sessionIdInternal,
        reducer: this.reducer,
        activeAgentId: this.activeAgentIdInternal,
      };
    }
    this.reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    this.armedInternal = true; // empty armed view: admit no stream updates
    this.pendingInternal = selection;
  }

  /** Cancels the armed selection: restores the parked transcript (and its
   *  agent binding) verbatim. Safe when nothing is parked. */
  cancelArm(): void {
    this.epochInternal += 1;
    const parked = this.parked;
    if (parked) {
      this.reducer = parked.reducer;
      this.sessionIdInternal = parked.sessionId;
      this.activeAgentIdInternal = parked.activeAgentId;
      this.parked = null;
    }
    this.armedInternal = false; // stream may paint the (restored) live session
    this.pendingInternal = null;
  }

  /** A deferred create adopted: the new session is live, the park is
   *  history, the agent binding is server-side truth (null for fresh). */
  commit(sessionId: string, agentId: string | null): void {
    this.liveSessionIdInternal = sessionId;
    this.armedInternal = false;
    this.sessionIdInternal = sessionId;
    this.pendingInternal = null;
    this.activeAgentIdInternal = agentId;
    this.parked = null;
  }

  /** Notification admission. 'painted' applied to
   *  the visible transcript; 'parked' applied to the parked reducer while
   *  armed; 'dropped' filtered. Only 'painted' proves connection liveness
   *  (watchdog traffic) or warrants a publish. */
  admit(notification: AcpNotification): AdmitResult {
    if (this.armedInternal) {
      const parked = this.parked;
      if (parked && notification.sessionId === this.liveSessionIdInternal) {
        parked.reducer.apply(notification);
        return "parked";
      }
      return "dropped";
    }
    if (
      this.liveSessionIdInternal !== null &&
      notification.sessionId !== this.liveSessionIdInternal
    ) {
      return "dropped";
    }
    this.reducer.apply(notification);
    return "painted";
  }

  /** First assistant-visible content flips thinking -> responding — the hook checks this after a painted admit. */
  paintedStreaming(): boolean {
    return this.reducer.runtime.streamingMessageId !== null;
  }

  /** Optimistic local echo: the user's BARE words (preamble is wire-only,
   *  house rule), plus attached images. */
  appendLocalEcho(args: {
    id: string;
    text: string;
    imageBlocks?: Array<Record<string, unknown>> | null;
  }): void {
    this.reducer.appendLocalUserMessage({ id: args.id, text: args.text });
    if (args.imageBlocks) {
      const message = this.reducer.messages.find((m) => m.id === args.id);
      for (const block of args.imageBlocks) {
        if (
          message &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          message.content.push({
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
          });
        }
      }
    }
  }

  /** Run-end cleanup (the prompt future resolved or the flow finished). */
  finishStreamingMessage(): void {
    this.reducer.finishStreamingMessage();
  }
}
