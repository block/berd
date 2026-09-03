import type {
  DirectBridgeMessage,
  DirectMessageExchange,
  MasterMessageMode,
} from "./realtimeEmissaryProtocol";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getOpenAiRealtimeVoiceControlsStatus } from "@/shared/api/openaiRealtime";

export type HandoffDispositionFailure = {
  accepted: false;
  reason: "unknown_handoff" | "context_cannot_resolve";
  cursor: number;
  handoffIds: string[];
};

export type MasterMessageDelivery =
  | {
      accepted: true;
      cursor: number;
      deliveryStatus: "sent" | "interrupting" | "queued";
      outbound: DirectBridgeMessage;
    }
  | Exclude<DirectMessageExchange, { accepted: true }>
  | HandoffDispositionFailure;

export type HandoffDismissal =
  | {
      accepted: true;
      cursor: number;
      dismissedHandoffIds: string[];
      deliveryStatus: "sent" | "interrupting" | "queued";
    }
  | Exclude<DirectMessageExchange, { accepted: true }>
  | HandoffDispositionFailure;

export interface RealtimeMasterTurnCompletion {
  reminderHandoffIds: string[];
}

export interface ActiveRealtimeEmissary {
  sessionId: string;
  sendMasterMessage(
    message: string,
    cursor: number,
    mode: MasterMessageMode,
    resolves: string[],
  ): Promise<MasterMessageDelivery>;
  dismissHandoffs(
    cursor: number,
    handoffIds: string[],
    reason: string,
  ): Promise<HandoffDismissal>;
  completeMasterTurn(completion: RealtimeMasterTurnCompletion): void;
}

let activeEmissary: ActiveRealtimeEmissary | null = null;
let remoteListener: Promise<UnlistenFn> | null = null;
const REMOTE_REQUEST_EVENT = "voice-conversation:spokesperson-bridge-request";
const REMOTE_RESPONSE_EVENT = "voice-conversation:spokesperson-bridge-response";
const REMOTE_RESPONSE_TIMEOUT_MS = 10_000;
const REALTIME_STATUS_TIMEOUT_MS = 1_000;

type RemoteBridgeRequest =
  | {
      id: string;
      action: "hasActive";
      sessionId: string;
    }
  | {
      id: string;
      action: "complete";
      sessionId: string;
      completion: RealtimeMasterTurnCompletion;
    }
  | {
      id: string;
      action: "send";
      sessionId: string;
      message: string;
      cursor: number;
      mode: MasterMessageMode;
      resolves: string[];
    }
  | {
      id: string;
      action: "dismiss";
      sessionId: string;
      cursor: number;
      handoffIds: string[];
      reason: string;
    };

type RemoteBridgeResponse = {
  id: string;
  active?: boolean;
  completed?: boolean;
  delivery?: MasterMessageDelivery;
  dismissal?: HandoffDismissal;
  error?: string;
};

function ensureRemoteListener(): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return Promise.resolve();
  if (remoteListener) return remoteListener.then(() => undefined);
  const registration = listen<RemoteBridgeRequest>(
    REMOTE_REQUEST_EVENT,
    async ({ payload }) => {
      const spokesperson = activeEmissary;
      if (!spokesperson || spokesperson.sessionId !== payload.sessionId) return;
      let response: RemoteBridgeResponse;
      try {
        switch (payload.action) {
          case "hasActive":
            response = { id: payload.id, active: true };
            break;
          case "complete":
            spokesperson.completeMasterTurn(payload.completion);
            response = { id: payload.id, completed: true };
            break;
          case "send":
            response = {
              id: payload.id,
              delivery: await spokesperson.sendMasterMessage(
                payload.message,
                payload.cursor,
                payload.mode,
                payload.resolves,
              ),
            };
            break;
          case "dismiss":
            response = {
              id: payload.id,
              dismissal: await spokesperson.dismissHandoffs(
                payload.cursor,
                payload.handoffIds,
                payload.reason,
              ),
            };
            break;
        }
      } catch (error) {
        response = {
          id: payload.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await emit(REMOTE_RESPONSE_EVENT, response);
    },
  );
  remoteListener = registration;
  void registration.catch((error) => {
    if (remoteListener === registration) remoteListener = null;
    console.error("Could not listen for remote Spokesperson messages", error);
  });
  return registration.then(() => undefined);
}

async function requestRemoteBridge(
  request:
    | Omit<Extract<RemoteBridgeRequest, { action: "hasActive" }>, "id">
    | Omit<Extract<RemoteBridgeRequest, { action: "complete" }>, "id">
    | Omit<Extract<RemoteBridgeRequest, { action: "send" }>, "id">
    | Omit<Extract<RemoteBridgeRequest, { action: "dismiss" }>, "id">,
): Promise<RemoteBridgeResponse | null> {
  if (!window.__TAURI_INTERNALS__) return null;
  let timeout: number | undefined;
  const status = await Promise.race([
    getOpenAiRealtimeVoiceControlsStatus(),
    new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(
        () =>
          reject(
            new Error("Timed out checking the OpenAI Realtime voice status."),
          ),
        REALTIME_STATUS_TIMEOUT_MS,
      );
    }),
  ]).finally(() => window.clearTimeout(timeout));
  if (
    status.lifecycle !== "running" ||
    status.sessionId !== request.sessionId
  ) {
    return null;
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = window.setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, REMOTE_RESPONSE_TIMEOUT_MS);
    void listen<RemoteBridgeResponse>(REMOTE_RESPONSE_EVENT, ({ payload }) => {
      if (payload.id !== id) return;
      window.clearTimeout(timeout);
      unlisten?.();
      if (payload.error) reject(new Error(payload.error));
      else resolve(payload);
    })
      .then((stop) => {
        unlisten = stop;
        return emit(REMOTE_REQUEST_EVENT, { ...request, id });
      })
      .catch((error) => {
        window.clearTimeout(timeout);
        unlisten?.();
        reject(error);
      });
  });
}

export function registerRealtimeEmissary(
  emissary: ActiveRealtimeEmissary,
): () => void {
  activeEmissary = emissary;
  void ensureRemoteListener().catch(() => undefined);
  return () => {
    if (activeEmissary === emissary) activeEmissary = null;
  };
}

export function hasLocalActiveRealtimeEmissary(sessionId: string): boolean {
  return activeEmissary?.sessionId === sessionId;
}

export async function waitForRealtimeEmissaryBridgeReady(): Promise<void> {
  await ensureRemoteListener();
}

export async function sendToActiveRealtimeSpokesperson(
  sessionId: string,
  message: string,
  cursor: number,
  mode: MasterMessageMode,
  resolves: string[],
): Promise<MasterMessageDelivery | null> {
  if (activeEmissary?.sessionId === sessionId) {
    return activeEmissary.sendMasterMessage(message, cursor, mode, resolves);
  }
  const response = await requestRemoteBridge({
    action: "send",
    sessionId,
    message,
    cursor,
    mode,
    resolves,
  });
  return response?.delivery ?? null;
}

export async function dismissActiveRealtimeHandoffs(
  sessionId: string,
  cursor: number,
  handoffIds: string[],
  reason: string,
): Promise<HandoffDismissal | null> {
  if (activeEmissary?.sessionId === sessionId) {
    return activeEmissary.dismissHandoffs(cursor, handoffIds, reason);
  }
  const response = await requestRemoteBridge({
    action: "dismiss",
    sessionId,
    cursor,
    handoffIds,
    reason,
  });
  return response?.dismissal ?? null;
}

export async function hasActiveRealtimeEmissary(
  sessionId: string,
): Promise<boolean> {
  if (activeEmissary?.sessionId === sessionId) return true;
  const response = await requestRemoteBridge({
    action: "hasActive",
    sessionId,
  });
  return response?.active === true;
}

export async function completeActiveRealtimeMasterTurn(
  sessionId: string,
  completion: RealtimeMasterTurnCompletion,
): Promise<boolean> {
  if (activeEmissary?.sessionId === sessionId) {
    activeEmissary.completeMasterTurn(completion);
    return true;
  }
  const response = await requestRemoteBridge({
    action: "complete",
    sessionId,
    completion,
  });
  return response?.completed === true;
}
