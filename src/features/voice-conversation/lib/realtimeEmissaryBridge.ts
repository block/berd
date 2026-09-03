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

type RemoteBridgeRequest =
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
  delivery?: MasterMessageDelivery;
  dismissal?: HandoffDismissal;
  error?: string;
};

function ensureRemoteListener(): void {
  if (!window.__TAURI_INTERNALS__ || remoteListener) return;
  const registration = listen<RemoteBridgeRequest>(
    REMOTE_REQUEST_EVENT,
    async ({ payload }) => {
      const spokesperson = activeEmissary;
      if (!spokesperson || spokesperson.sessionId !== payload.sessionId) return;
      let response: RemoteBridgeResponse;
      try {
        response =
          payload.action === "send"
            ? {
                id: payload.id,
                delivery: await spokesperson.sendMasterMessage(
                  payload.message,
                  payload.cursor,
                  payload.mode,
                  payload.resolves,
                ),
              }
            : {
                id: payload.id,
                dismissal: await spokesperson.dismissHandoffs(
                  payload.cursor,
                  payload.handoffIds,
                  payload.reason,
                ),
              };
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
}

async function requestRemoteBridge(
  request:
    | Omit<Extract<RemoteBridgeRequest, { action: "send" }>, "id">
    | Omit<Extract<RemoteBridgeRequest, { action: "dismiss" }>, "id">,
): Promise<RemoteBridgeResponse | null> {
  if (!window.__TAURI_INTERNALS__) return null;
  const status = await getOpenAiRealtimeVoiceControlsStatus();
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
  ensureRemoteListener();
  return () => {
    if (activeEmissary === emissary) activeEmissary = null;
  };
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

export function getActiveRealtimeEmissary(): ActiveRealtimeEmissary | null {
  return activeEmissary;
}

export function hasActiveRealtimeEmissary(sessionId: string): boolean {
  return activeEmissary?.sessionId === sessionId;
}

export function completeActiveRealtimeMasterTurn(
  sessionId: string,
  completion: RealtimeMasterTurnCompletion,
): void {
  if (activeEmissary?.sessionId !== sessionId) return;
  activeEmissary.completeMasterTurn(completion);
}
