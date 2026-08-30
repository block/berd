import type {
  DirectBridgeMessage,
  DirectMessageExchange,
} from "./realtimeEmissaryProtocol";

export type MasterMessageDelivery =
  | {
      accepted: true;
      cursor: number;
      deliveryStatus: "sent" | "interrupting" | "queued";
      outbound: DirectBridgeMessage;
    }
  | Exclude<DirectMessageExchange, { accepted: true }>;

export interface ActiveRealtimeEmissary {
  sessionId: string;
  beginMasterTurn(turnId: string): void;
  endMasterTurn(completion: MasterTurnCompletion): void;
  sendMasterMessage(
    message: string,
    cursor: number,
  ): Promise<MasterMessageDelivery>;
}

export interface MasterTurnCompletion {
  turnId: string;
  status: "completed" | "cancelled" | "failed";
  finalText?: string;
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

export function beginActiveRealtimeMasterTurn(
  sessionId: string,
  turnId: string,
): boolean {
  if (!activeEmissary || activeEmissary.sessionId !== sessionId) return false;
  activeEmissary.beginMasterTurn(turnId);
  return true;
}

export function endActiveRealtimeMasterTurn(
  sessionId: string,
  completion: MasterTurnCompletion,
): void {
  if (!activeEmissary || activeEmissary.sessionId !== sessionId) return;
  activeEmissary.endMasterTurn(completion);
}
