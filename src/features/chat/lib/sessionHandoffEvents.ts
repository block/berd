import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const SESSION_HANDOFF_SNAPSHOT_AVAILABLE =
  "session-handoff-snapshot-available";

export interface SessionHandoffSnapshotAvailable {
  sessionId: string;
  toLabel: string;
  version: number;
  isFinal: boolean;
}

export function listenSessionHandoffSnapshotAvailable(
  handler: (payload: SessionHandoffSnapshotAvailable) => void,
): Promise<UnlistenFn> {
  return listen<SessionHandoffSnapshotAvailable>(
    SESSION_HANDOFF_SNAPSHOT_AVAILABLE,
    (event) => {
      handler(event.payload);
    },
  );
}
