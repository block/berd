import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { SessionDateGroup } from "./groupSessionsByDate";

export type GroupedSessionRow =
  | { kind: "header"; key: string; label: string }
  // `cardOffset` is the number of cards that precede this row across the whole
  // list, so a staggered entrance can cascade continuously instead of
  // restarting its delay on every row.
  | { kind: "cards"; key: string; sessions: ChatSession[]; cardOffset: number };

export interface FlatSessionRow<T> {
  kind: "cards";
  key: string;
  items: T[];
  cardOffset: number;
}

function normalizeColumns(columns: number): number {
  return Math.max(1, Math.floor(columns));
}

export function flattenGroupedSessionRows(
  groups: SessionDateGroup[],
  columns: number,
): GroupedSessionRow[] {
  const rows: GroupedSessionRow[] = [];
  const chunkSize = normalizeColumns(columns);
  let cardOffset = 0;

  for (const group of groups) {
    rows.push({ kind: "header", key: `h:${group.label}`, label: group.label });
    for (let index = 0; index < group.sessions.length; index += chunkSize) {
      const chunk = group.sessions.slice(index, index + chunkSize);
      const firstSession = chunk[0];
      if (!firstSession) {
        continue;
      }
      rows.push({
        kind: "cards",
        key: `r:${group.label}:${firstSession.id}`,
        sessions: chunk,
        cardOffset,
      });
      cardOffset += chunk.length;
    }
  }

  return rows;
}

export function flattenFlatSessionRows<T extends { session: ChatSession }>(
  items: T[],
  columns: number,
  toSession: (item: T) => ChatSession = (item) => item.session,
): FlatSessionRow<T>[] {
  const rows: FlatSessionRow<T>[] = [];
  const chunkSize = normalizeColumns(columns);

  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const firstItem = chunk[0];
    if (!firstItem) {
      continue;
    }
    rows.push({
      kind: "cards",
      key: `r:${toSession(firstItem).id}`,
      items: chunk,
      cardOffset: index,
    });
  }

  return rows;
}
