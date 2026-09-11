import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getOpenAiRealtimeVoiceControlsStatus } from "@/shared/api/openaiRealtime";

export type GptLiveAppendChannel = "commentary" | "thinking";

export type GptLiveAppendResult =
  | { accepted: true; cursor: number }
  | {
      accepted: false;
      reason: "pipe_busy" | "stale_cursor" | "unknown_delegation";
      cursor: number;
    };

export interface ActiveGptLiveBridge {
  sessionId: string;
  append(
    message: string,
    cursor: number,
    channel: GptLiveAppendChannel,
    delegationId?: string,
  ): Promise<GptLiveAppendResult>;
}

let activeBridge: ActiveGptLiveBridge | null = null;
let remoteListener: Promise<UnlistenFn> | null = null;
const REQUEST_EVENT = "voice-conversation:gpt-live-bridge-request";
const RESPONSE_EVENT = "voice-conversation:gpt-live-bridge-response";
const RESPONSE_TIMEOUT_MS = 10_000;

type RemoteRequest = {
  id: string;
  sessionId: string;
  message: string;
  cursor: number;
  channel: GptLiveAppendChannel;
  delegationId?: string;
};

type RemoteResponse = {
  id: string;
  result?: GptLiveAppendResult;
  error?: string;
};

function ensureRemoteListener(): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return Promise.resolve();
  if (remoteListener) return remoteListener.then(() => undefined);
  const registration = listen<RemoteRequest>(
    REQUEST_EVENT,
    async ({ payload }) => {
      const bridge = activeBridge;
      if (!bridge || bridge.sessionId !== payload.sessionId) return;
      let response: RemoteResponse;
      try {
        response = {
          id: payload.id,
          result: await bridge.append(
            payload.message,
            payload.cursor,
            payload.channel,
            payload.delegationId,
          ),
        };
      } catch (error) {
        response = {
          id: payload.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await emit(RESPONSE_EVENT, response);
    },
  );
  remoteListener = registration;
  void registration.catch((error) => {
    if (remoteListener === registration) remoteListener = null;
    console.error("Could not listen for GPT Live bridge messages", error);
  });
  return registration.then(() => undefined);
}

export function registerGptLiveBridge(bridge: ActiveGptLiveBridge): () => void {
  activeBridge = bridge;
  void ensureRemoteListener().catch(() => undefined);
  return () => {
    if (activeBridge === bridge) activeBridge = null;
  };
}

export async function waitForGptLiveBridgeReady(): Promise<void> {
  await ensureRemoteListener();
}

export async function appendToActiveGptLive(
  sessionId: string,
  message: string,
  cursor: number,
  channel: GptLiveAppendChannel,
  delegationId?: string,
): Promise<GptLiveAppendResult | null> {
  if (activeBridge?.sessionId === sessionId) {
    return activeBridge.append(message, cursor, channel, delegationId);
  }
  if (!window.__TAURI_INTERNALS__) return null;
  const status = await getOpenAiRealtimeVoiceControlsStatus();
  if (status.lifecycle !== "running" || status.sessionId !== sessionId)
    return null;

  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = window.setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, RESPONSE_TIMEOUT_MS);
    void listen<RemoteResponse>(RESPONSE_EVENT, ({ payload }) => {
      if (payload.id !== id) return;
      window.clearTimeout(timeout);
      unlisten?.();
      if (payload.error) reject(new Error(payload.error));
      else resolve(payload.result ?? null);
    })
      .then((stop) => {
        unlisten = stop;
        return emit(REQUEST_EVENT, {
          id,
          sessionId,
          message,
          cursor,
          channel,
          delegationId,
        } satisfies RemoteRequest);
      })
      .catch((error) => {
        window.clearTimeout(timeout);
        unlisten?.();
        reject(error);
      });
  });
}
