import type { WidgetInstance } from "@/features/home/widgets/types";

function normalizedStateId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id || null;
}

/**
 * Returns the chats pinned to Home that also belong in the sidebar's compact
 * Pinned section. Project widgets stay on Home and do not become sidebar
 * navigation groups.
 */
export function getPinnedHomeChatSessionIdsInOrder(
  instances: readonly WidgetInstance[],
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const instance of instances) {
    if (instance.type !== "chatPin") continue;
    const id = normalizedStateId(instance.state?.sessionId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

export function getPinnedHomeChatSessionIds(
  instances: readonly WidgetInstance[],
): ReadonlySet<string> {
  return new Set(getPinnedHomeChatSessionIdsInOrder(instances));
}
