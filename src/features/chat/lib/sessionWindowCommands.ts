import { invoke } from "@tauri-apps/api/core";

import type { SessionWindowEntry } from "@/features/chat/stores/sessionWindowStore";

interface OpenSessionWindowOptions {
  handoffFrom?: string;
}

export async function openSessionWindow(
  sessionId: string,
  options: OpenSessionWindowOptions = {},
): Promise<void> {
  await invoke("open_session_window", {
    sessionId,
    handoffFrom: options.handoffFrom ?? null,
  });
}

export async function focusSessionWindow(sessionId: string): Promise<void> {
  await invoke("focus_session_window", { sessionId });
}

export async function releaseSession(sessionId: string): Promise<void> {
  await invoke("release_session", { sessionId });
}

export async function completeSessionHandoff(sessionId: string): Promise<void> {
  await invoke("complete_session_handoff", { sessionId });
}

export async function listSessionWindows(): Promise<SessionWindowEntry[]> {
  return invoke<SessionWindowEntry[]>("list_session_windows");
}
