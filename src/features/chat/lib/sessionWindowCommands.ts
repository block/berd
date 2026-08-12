import { invoke } from "@tauri-apps/api/core";

import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import type { SessionWindowEntry } from "@/features/chat/stores/sessionWindowStore";
import { shareInFlight } from "@/shared/lib/shareInFlight";
import type { SessionChatRuntime } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

export interface SessionWindowSupport {
  supported: boolean;
  reason?: string;
}

export interface SessionHandoffPayload {
  sessionId: string;
  fromLabel: string;
  toLabel: string;
  messages: Message[];
  sessionState: SessionChatRuntime | undefined;
  queuedMessages?: QueuedMessageRecord[];
}

export interface SessionHandoffSnapshot {
  version: number;
  isFinal: boolean;
  payload: SessionHandoffPayload;
}

export interface JoinSessionHandoffResult {
  mode: SessionWindowEntry["mode"];
  snapshot?: SessionHandoffSnapshot;
}

// Every mounted `useSessionWindowSupport` asks on mount and passes
// `{ coalesce: true }` so simultaneous mounts issue a single IPC call.
export const getSessionWindowSupport = shareInFlight(() =>
  invoke<SessionWindowSupport>("get_session_window_support"),
);

export async function openSessionWindow(
  sessionId: string,
  options: { handoff?: boolean } = {},
): Promise<void> {
  await invoke("open_session_window", {
    sessionId,
    handoff: options.handoff ?? false,
  });
}

export async function focusSessionWindow(sessionId: string): Promise<void> {
  await invoke("focus_session_window", { sessionId });
}

export async function releaseSession(sessionId: string): Promise<void> {
  await invoke("release_session", { sessionId });
}

export async function joinSessionHandoff(
  sessionId: string,
): Promise<JoinSessionHandoffResult> {
  return invoke<JoinSessionHandoffResult>("join_session_handoff", {
    sessionId,
  });
}

export async function publishSessionHandoffSnapshot(
  sessionId: string,
  payload: SessionHandoffPayload,
): Promise<void> {
  await invoke("publish_session_handoff_snapshot", {
    sessionId,
    snapshot: { payload },
  });
}

export async function finishSessionHandoff(
  sessionId: string,
  payload: SessionHandoffPayload,
): Promise<void> {
  await invoke("finish_session_handoff", {
    sessionId,
    snapshot: { payload },
  });
}

export async function readSessionHandoffSnapshot(
  sessionId: string,
  afterVersion?: number,
): Promise<SessionHandoffSnapshot | null> {
  return invoke<SessionHandoffSnapshot | null>(
    "read_session_handoff_snapshot",
    {
      sessionId,
      afterVersion: afterVersion ?? null,
    },
  );
}

export async function recoverSessionHandoff(sessionId: string): Promise<void> {
  await invoke("recover_session_handoff", { sessionId });
}

export async function listSessionWindows(): Promise<SessionWindowEntry[]> {
  return invoke<SessionWindowEntry[]>("list_session_windows");
}
