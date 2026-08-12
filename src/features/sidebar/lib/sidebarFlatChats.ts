import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
import type { SidebarSessionItem } from "@/features/sessions/ui/session-list/SidebarProjectSection";

export interface FlatChatGroup {
  id: "pinned" | "last-hour" | "last-day" | "older";
  sessions: SidebarSessionItem[];
}

export const MAX_FLAT_SIDEBAR_CHATS = 30;
const FLAT_CHAT_GROUP_DEFINITIONS: Array<Omit<FlatChatGroup, "sessions">> = [
  { id: "pinned" },
  { id: "last-hour" },
  { id: "last-day" },
  { id: "older" },
];

function getFlatChatGroupId(
  session: Pick<SidebarSessionItem, "lastMessageAt" | "updatedAt">,
  nowMs: number,
): FlatChatGroup["id"] {
  const updatedMs = Date.parse(sessionActivityAt(session));
  if (!Number.isFinite(updatedMs)) {
    return "older";
  }

  const ageMs = Math.max(0, nowMs - updatedMs);
  if (ageMs < 60 * 60 * 1000) {
    return "last-hour";
  }
  if (ageMs < 24 * 60 * 60 * 1000) {
    return "last-day";
  }
  return "older";
}

export function groupFlatChatsByActivityAge(
  sessions: SidebarSessionItem[],
  nowMs: number = Date.now(),
  pinnedSessionIds: ReadonlySet<string> = new Set(),
): FlatChatGroup[] {
  const groups = new Map<FlatChatGroup["id"], FlatChatGroup>(
    FLAT_CHAT_GROUP_DEFINITIONS.map((group) => [
      group.id,
      { ...group, sessions: [] },
    ]),
  );

  for (const session of sessions) {
    const groupId = pinnedSessionIds.has(session.id)
      ? "pinned"
      : getFlatChatGroupId(session, nowMs);
    groups.get(groupId)?.sessions.push(session);
  }

  return FLAT_CHAT_GROUP_DEFINITIONS.map((group) => groups.get(group.id))
    .filter((group): group is FlatChatGroup => Boolean(group))
    .filter((group) => group.sessions.length > 0);
}

export function limitFlatSidebarSessions(
  sessions: SidebarSessionItem[],
): SidebarSessionItem[] {
  return sessions.slice(0, MAX_FLAT_SIDEBAR_CHATS);
}
