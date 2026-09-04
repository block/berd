export interface RealtimeEventTransport {
  send(data: string): void;
}

export function sendRealtimeEvents(
  transport: RealtimeEventTransport,
  events: readonly Record<string, unknown>[],
): void {
  for (const event of events) transport.send(JSON.stringify(event));
}

export type MasterMessageMode = "context" | "say";
