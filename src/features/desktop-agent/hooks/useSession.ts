// Session state hook — a thin composer over unit-tested modules; this
// hook owns only the React glue:
//
//   PanelConnection   single-flight attach + one-shot auto re-attach over
//                     the shared per-webview ACP connection
//   SessionStore      armed/parked/commit machine + admission + epoch
//   SendController    the send paths, composer gate, stop()
//   panelAcp          direct-ACP session create (persona bound at create
//                     time), prompt, cancel, adopt probe
//
// In-process integration notes: the panel is its own webview, so the
// shared acpConnection module gives it its OWN GooseClient. Sessions are
// created directly over that connection — the first response streams live
// (no dispatch, no export backfill). goosed lives and dies with Berd, so
// reconnect is one automatic fresh dial after a close, then a manual
// retry affordance (no blind retry loop).
//
// Deferred chats: select() is PURE UI STATE — nothing is created until
// the first send (product rule). Both create paths stream live.

import { useCallback, useEffect, useRef, useState } from "react";

import { getClient, setNotificationHandler } from "@/shared/api/acpConnection";

import { notificationFromSessionUpdate } from "../lib/acpNotification";
import type { ChatMessage } from "../lib/chatModels";
import {
  adoptSession,
  cancelPanelSession,
  createAgentSession,
  createFreshSession,
  promptSession,
} from "../lib/panelAcp";
import { PanelConnection } from "../lib/panelConnection";
import { SendController } from "../lib/sendController";
import { SessionStore } from "../lib/sessionStore";
import { StallWatchdog } from "../lib/stallWatchdog";

export interface AgentInfo {
  agentId: string;
  name: string;
  systemPrompt: string;
  provider: string | null;
  model: string | null;
}

/** What the next chat is armed to be: an agent-bound session (persona
 *  bound at create time) or a fresh plain session (the default entry). */
export type PendingSelection =
  | { kind: "agent"; agent: AgentInfo }
  | { kind: "fresh" };

export type SessionActivity = "none" | "thinking" | "responding";

/** Fresh state, Berd-owned: the panel's only persistence. */
export const SESSION_ID_STORAGE_KEY = "goose:desktop-agent:session-id";
export const AGENT_ID_STORAGE_KEY = "goose:desktop-agent:agent-id";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; the current webview keeps working.
  }
}

/** One instance per hook life, created on first render. These instances
 *  ARE the hook's state machines — closures capture them directly, so
 *  once-registered listeners always read live values. */
function useSingleton<T>(create: () => T): T {
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = create();
  }
  return ref.current;
}

export interface SessionView {
  attached: boolean;
  sessionId: string | null;
  messages: ChatMessage[];
  activity: SessionActivity;
  lastSendError: string | null;
  /** Connection/attach failure — own channel so reconnect churn never
   *  stomps a send error. Rendered only while disconnected. */
  connectionError: string | null;
  /** No further automatic reconnect attempt is coming — the UI must stop
   *  saying "reconnecting" and offer the manual retry. */
  reconnectExhausted: boolean;
  /** Manual retry affordance after exhaustion. */
  retry(): void;
  /** Thinking with zero updates for 25s — surfaces a hint, never aborts
   *  the send. */
  sendStalled: boolean;
  /** What the NEXT chat is armed to be — pure UI state until the first
   *  send (product rule: selection creates nothing). */
  pendingSelection: PendingSelection | null;
  /** Agent bound to the CURRENT session: set when an agent chat commits,
   *  cleared on fresh commit, restored from persistence at adopt. Drives
   *  the avatar. */
  activeAgentId: string | null;
  /** True while a deferred create is in flight (before streaming takes
   *  over); the composer shows agent-starting state. */
  agentSendInFlight: boolean;
  /** SYNCHRONOUS live view of the send gate: true while a deferred
   *  create is in flight OR a run is active on the live session (goosed
   *  rejects concurrent prompts per session — mid-run sends are
   *  disallowed). The composer must check this BEFORE
   *  clearing the draft — React state lags a render, and a send()
   *  bounced off the internal guards would otherwise eat the message
   *  silently. */
  sendBusy(): boolean;
  /** Stops the in-flight run (session/cancel). Fire-and-forget: the
   *  pending prompt resolves normally with stopReason "cancelled". */
  stop(): Promise<void>;
  /** Arms a deferred chat: clears the transcript view, holds the
   *  selection until the first send. Passing null cancels back to the
   *  current session unchanged. */
  select(selection: PendingSelection | null): void;
  /** Resolves true when the message DISPATCHED (echo appended, delivery
   *  attempted — failures land on lastSendError) and false when it
   *  BOUNCED off a send gate untouched. A composer with an async gap
   *  between its gate check and this call (the perch capture path) must
   *  restore the cleared draft on false — otherwise the bounce eats the
   *  message.
   *
   *  makePreamble (perch sends): builds the wire-only identity preamble
   *  from live perch state; the controller decides full-vs-slim guidance
   *  and owns the ledger. Absent for ordinary sends. */
  send(
    text: string,
    imageBlocks?: Array<Record<string, unknown>>,
    makePreamble?: ((fullGuidance: boolean) => string | null) | null,
  ): Promise<boolean>;
}

export function useSession(): SessionView {
  // Canonical session/transcript state machine. React state below mirrors
  // the store after each mutating call.
  const store = useSingleton(() => new SessionStore());
  const [attached, setAttached] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<SessionActivity>("none");
  const [lastSendError, setLastSendError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [sendStalled, setSendStalled] = useState(false);
  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [agentSendInFlight, setAgentSendInFlight] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const watchdog = useSingleton(() => new StallWatchdog(setSendStalled));

  const publish = useCallback(() => {
    // store.messages is already a fresh-array snapshot (publish contract).
    setMessages(store.messages);
  }, [store]);

  // Send flows: the SendController owns the send paths and the
  // createInFlight composer gate. Constructed once — its ports close over
  // the store and stable setters; the onCommitted sink mirrors the
  // store's canonical values into React state and persists the ids.
  const controller = useSingleton(
    () =>
      new SendController(
        store,
        {
          prompt: (args) => promptSession(args.sessionId, args.content),
          createAgentSession: (agent) => createAgentSession(agent),
          createFreshSession: () => createFreshSession(),
          cancel: (id) => cancelPanelSession(id),
        },
        {
          setActivity,
          setLastSendError,
          setAgentSendInFlight,
          onCommitted: () => {
            setSessionId(store.sessionId);
            setPendingSelection(store.pendingSelection);
            setActiveAgentId(store.activeAgentId);
            writeStorage(SESSION_ID_STORAGE_KEY, store.sessionId);
            writeStorage(AGENT_ID_STORAGE_KEY, store.activeAgentId);
          },
          publish: () => setMessages(store.messages),
        },
      ),
  );

  // Armed on entering thinking, cleared on leaving. NOT armed during a
  // deferred create: the create RPC has its own error path, and the
  // watchdog would false-fire on slow persona setup.
  useEffect(() => {
    if (activity === "thinking" && !agentSendInFlight) {
      watchdog.arm();
    } else {
      watchdog.clear();
    }
  }, [activity, agentSendInFlight, watchdog]);

  // Dispose: no late fires after unmount.
  useEffect(() => () => watchdog.clear(), [watchdog]);

  // Adopt-or-wait: after (re-)attach, re-adopt the persisted session via
  // session/load — the replay streams through the notification handler
  // and repaints the transcript from server truth. Only a DEFINITIVE
  // stale id (goosed refused it over a healthy connection) clears
  // persistence; a transient failure (connection died mid-probe) keeps
  // the ids so the reconnect's re-adopt can retry — wiping on transient
  // failures silently unlinked the conversation forever (review 5.3).
  const adoptOnAttach = useCallback(async () => {
    const persistedId = readStorage(SESSION_ID_STORAGE_KEY);
    if (persistedId !== null) {
      store.resetForAdopt(persistedId);
      publish();
      const outcome = await adoptSession(persistedId);
      if (outcome === "adopted") {
        const agentId = readStorage(AGENT_ID_STORAGE_KEY);
        if (agentId !== null && !store.armed) {
          store.restoreAgentBinding(agentId);
          setActiveAgentId(agentId);
        }
        if (!store.armed) setSessionId(persistedId);
      } else if (outcome === "stale") {
        writeStorage(SESSION_ID_STORAGE_KEY, null);
        writeStorage(AGENT_ID_STORAGE_KEY, null);
        store.resetForAdopt(null);
        if (!store.armed) {
          setSessionId(null);
          // The store unlinked the agent binding too — an agent avatar
          // over a null session would be the wrong face until the next
          // commit corrected it (review Check 4 LOW).
          setActiveAgentId(null);
        }
        publish();
      } else {
        // Transient: persistence untouched. The store keeps the
        // persisted id as its live id (half-replayed transcript is
        // replaced wholesale by the NEXT successful adopt's
        // resetForAdopt), and the connection's close monitor is about
        // to fire onDetached → auto re-attach → this function again.
      }
    }
    setAttached(true);
    setConnectionError(null);
    setReconnectExhausted(false);
  }, [publish, store]);

  // The connection is constructed once; route its callback through a ref
  // so it always calls the latest adoptOnAttach.
  const adoptOnAttachRef = useRef(adoptOnAttach);
  adoptOnAttachRef.current = adoptOnAttach;

  // Connection lifecycle: single-flight attach over the shared client,
  // one automatic re-attach after a close, exhaustion after that.
  const connection = useSingleton(
    () =>
      new PanelConnection(
        { connect: () => getClient() },
        {
          onAttached: () => {
            void adoptOnAttachRef.current();
          },
          onDetached: () => {
            setAttached(false);
            setActivity("none");
          },
          onFailed: (error, exhausted) => {
            setConnectionError(error);
            if (exhausted) setReconnectExhausted(true);
          },
        },
      ),
  );

  // Attach on mount. revive() undoes the previous cleanup's dispose
  // (StrictMode mounts twice; the connection instance survives).
  useEffect(() => {
    connection.revive();
    void connection.attach();
    return () => connection.dispose();
  }, [connection]);

  // Manual retry after exhaustion.
  const retry = useCallback(() => {
    setReconnectExhausted(false);
    void connection.attach();
  }, [connection]);

  // Stream notifications into the store. The shared connection hands
  // SessionNotification objects to the registered handler; admission
  // control lives in SessionStore.admit (armed view admits nothing,
  // foreign sessions drop). Only 'painted' admissions prove liveness.
  useEffect(() => {
    setNotificationHandler({
      handleSessionNotification: async (notification) => {
        const mapped = notificationFromSessionUpdate(
          notification.sessionId,
          notification.update as unknown as Record<string, unknown>,
        );
        if (!mapped) return;
        if (store.admit(mapped) !== "painted") return;
        // Traffic proves liveness — re-arms the stall watchdog.
        watchdog.noteTraffic();
        // First assistant-visible content flips thinking -> responding.
        if (store.paintedStreaming()) {
          setActivity((current) =>
            current === "thinking" ? "responding" : current,
          );
        }
        publish();
      },
    });
    // No unregister API: the handler is webview-scoped and the panel IS
    // this webview — it lives exactly as long as the handler should.
  }, [publish, store, watchdog]);

  // Arms (or cancels) a deferred chat. Selection is PURE UI state: the
  // current transcript is parked, the view goes empty, and NOTHING exists
  // server-side until the first send. Cancelling (null) restores the
  // parked transcript verbatim.
  const select = useCallback(
    (selection: PendingSelection | null) => {
      // Cleared on EVERY selection change, not just cancel: a re-select
      // mid-create orphans the create's finally (epoch mismatch), and a
      // stuck true here is an input lock now that the composer gates on
      // it.
      setAgentSendInFlight(false);
      if (selection === null) {
        store.cancelArm(); // bumps the epoch
        // The scratch view (and any failed send it hosted) is being
        // discarded — a lingering "Couldn't send" describing a message
        // that is no longer on screen would be a lie (review 5.3).
        setLastSendError(null);
        setSessionId(store.sessionId);
        setActiveAgentId(store.activeAgentId);
        setPendingSelection(null);
        setActivity("none");
        setMessages(store.messages);
        return;
      }
      store.arm(selection); // bumps the epoch; scratch reducer replaced
      setPendingSelection(selection);
      setLastSendError(null);
      setActivity("none");
      setMessages([]);
    },
    [store],
  );

  const stop = useCallback(() => controller.stop(), [controller]);

  const send = useCallback(
    (
      text: string,
      imageBlocks?: Array<Record<string, unknown>>,
      makePreamble?: ((fullGuidance: boolean) => string | null) | null,
    ) => controller.send(text, imageBlocks, makePreamble),
    [controller],
  );

  return {
    attached,
    sessionId,
    messages,
    activity,
    lastSendError,
    connectionError,
    reconnectExhausted,
    retry,
    sendStalled,
    pendingSelection,
    activeAgentId,
    agentSendInFlight,
    sendBusy: () => controller.busy,
    stop,
    select,
    send,
  };
}
