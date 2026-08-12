import type { Connection } from "@/features/connections/api/connections";

export type ConnectionStatus =
  | { kind: "active" }
  | { kind: "expiring"; daysUntilExpiry: number }
  | { kind: "expired" }
  | { kind: "disconnected" };

export const CONNECTION_STATUS_PRIORITY: Record<
  ConnectionStatus["kind"],
  number
> = {
  expired: 0,
  expiring: 1,
  active: 2,
  disconnected: 3,
};

const SECONDS_IN_DAY = 86_400;
const EXPIRY_WARNING_WINDOW_MS = 7 * SECONDS_IN_DAY * 1000;

export function resolveConnectionStatus(
  connection: Connection | undefined,
  nowMs: number = Date.now(),
): ConnectionStatus {
  if (!connection) return { kind: "disconnected" };

  const expiresAtEpochS = connection.expiresAtEpochS;
  const expiresAtMs =
    expiresAtEpochS !== undefined ? expiresAtEpochS * 1000 : undefined;

  if (
    connection.previouslyConnected === true &&
    (expiresAtMs === undefined || expiresAtMs <= nowMs)
  ) {
    return { kind: "expired" };
  }

  if (expiresAtEpochS === undefined || expiresAtMs === undefined) {
    return { kind: "active" };
  }

  if (expiresAtMs <= nowMs) return { kind: "expired" };

  if (expiresAtMs - nowMs <= EXPIRY_WARNING_WINDOW_MS) {
    const nowSeconds = Math.floor(nowMs / 1000);
    const daysUntilExpiry = Math.floor(
      (expiresAtEpochS - nowSeconds) / SECONDS_IN_DAY,
    );
    return { kind: "expiring", daysUntilExpiry };
  }

  return { kind: "active" };
}
