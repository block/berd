import type {
  DirectBridgeMessage,
  DirectMessageExchange,
  MasterMessageMode,
} from "./realtimeEmissaryProtocol";

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

export function registerRealtimeEmissary(
  emissary: ActiveRealtimeEmissary,
): () => void {
  activeEmissary = emissary;
  return () => {
    if (activeEmissary === emissary) activeEmissary = null;
  };
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
