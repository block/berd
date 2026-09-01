import type {
  DirectBridgeMessage,
  DirectMessageExchange,
  MasterMessageMode,
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
  sendMasterMessage(
    message: string,
    cursor: number,
    mode: MasterMessageMode,
  ): Promise<MasterMessageDelivery>;
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
