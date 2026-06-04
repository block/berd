import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { SessionChatRuntime } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

export const SESSION_HANDOFF_SNAPSHOT = "session-handoff-snapshot";
export const SESSION_HANDOFF_COMPLETE = "session-handoff-complete";
export const SESSION_HANDOFF_FAILED = "session-handoff-failed";

export interface SessionHandoffSnapshot {
  sessionId: string;
  fromLabel: string;
  toLabel: string;
  messages: Message[];
  sessionState: SessionChatRuntime | undefined;
}

export interface SessionHandoffComplete {
  sessionId: string;
  fromLabel: string;
  toLabel: string;
}

export interface SessionHandoffFailed {
  sessionId: string;
  fromLabel: string;
  toLabel: string;
  reason: string;
}

export function emitSessionHandoffSnapshot(
  toLabel: string,
  payload: SessionHandoffSnapshot,
): Promise<void> {
  return emitTo(toLabel, SESSION_HANDOFF_SNAPSHOT, payload);
}

export function emitSessionHandoffComplete(
  toLabel: string,
  payload: SessionHandoffComplete,
): Promise<void> {
  return emitTo(toLabel, SESSION_HANDOFF_COMPLETE, payload);
}

export function emitSessionHandoffFailed(
  toLabel: string,
  payload: SessionHandoffFailed,
): Promise<void> {
  return emitTo(toLabel, SESSION_HANDOFF_FAILED, payload);
}

export function listenSessionHandoffSnapshots(
  handler: (payload: SessionHandoffSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<SessionHandoffSnapshot>(SESSION_HANDOFF_SNAPSHOT, (event) => {
    handler(event.payload);
  });
}

export function listenSessionHandoffComplete(
  handler: (payload: SessionHandoffComplete) => void,
): Promise<UnlistenFn> {
  return listen<SessionHandoffComplete>(SESSION_HANDOFF_COMPLETE, (event) => {
    handler(event.payload);
  });
}

export function listenSessionHandoffFailed(
  handler: (payload: SessionHandoffFailed) => void,
): Promise<UnlistenFn> {
  return listen<SessionHandoffFailed>(SESSION_HANDOFF_FAILED, (event) => {
    handler(event.payload);
  });
}
